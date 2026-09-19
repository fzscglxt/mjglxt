/**
 * 模具管理系统 - 云端数据同步 API (Cloudflare Pages Functions)
 *
 * 接口规范：
 *   GET     /api/db  → 拉取云端最新数据 { version, updatedAt, db }
 *   PUT     /api/db  → 推送本地数据到云端（带 If-Version 头做乐观锁）
 *   POST    /api/db  → 接收生产系统全量生产事件，按"使用周期"规则重建出入库
 *   OPTIONS /api/db  → CORS 预检
 *
 * KV 存储：
 *   key: "mold_db_v1"
 *   value: { version: number, updatedAt: number, db: object, savedBy: string }
 *
 * 出入库"使用周期"规则：
 *   1. 机台使用模具/工装A生产 → A出库；同机台更换为B → A入库、B出库
 *   2. A连续生产若干天 → 周期首日出库、末日入库，入库模次/时长为整周期合计
 *   3. 机台生产若干天后闲置（日期断开或数据结束）→ 末日入库
 */

const KV_KEY = 'mold_db_v1';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-Version',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

async function readData(kv) {
  try {
    const raw = await kv.get(KV_KEY, 'json');
    if (raw && typeof raw === 'object') {
      return {
        version: typeof raw.version === 'number' ? raw.version : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        db: raw.db || null,
        savedBy: raw.savedBy || '',
      };
    }
  } catch (e) {
    console.error('KV read error:', e);
  }
  return { version: 0, updatedAt: 0, db: null, savedBy: '' };
}

async function writeData(kv, data) {
  await kv.put(KV_KEY, JSON.stringify(data));
}

// ============================================================
// 出入库"使用周期"重建算法（与前端 index.html 中保持一致）
// ============================================================

// 日期相差天数（b - a），入参为 'YYYY-MM-DD'
function dayDiff(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db2 = new Date(b + 'T00:00:00');
  return Math.round((db2 - da) / 86400000);
}

/**
 * 根据一个类型（mold模具 / fixture工装）的全量生产事件，生成自动出入库记录
 * 事件字段：{ recordId, date, machine, code, productName, qty, duration, shift }
 *
 * 模型：按 (机台, 模具/工装编号) 二元组独立计算连续使用日期段
 *   - 同一机台同一编号，生产日期相邻≤1天（含同日）合并为一个使用周期，
 *     周期首日出库（模次/时长为0）、末日入库（模次/时长为整周期合计）
 *   - 生产日期断开（间隔>1天，机台闲置）→ 末日入库，再生产时重新出库
 *   - 同机台更换别的编号 → 旧编号在其最后生产日入库、新编号在其最早生产日出库
 *   - 数据末尾仍在机台的编号 → 最后生产日入库
 *   - 同一天同一机台即使录入了多个编号（按产品逐条录入），各编号按自身
 *     连续日期段独立成周期，不被同日其他编号的录入顺序打散
 */
function buildAutoUsage(events, targetType, operatorName) {
  const records = [];
  const valid = (events || [])
    .filter(e => e && e.date && e.machine && e.code)
    .map(e => ({
      date: String(e.date).slice(0, 10),
      machine: String(e.machine),
      code: String(e.code),
      qty: Number(e.qty) || 0,
      duration: Number(e.duration) || 0
    }));

  // 按 (机台, 编号) 分组，并按日聚合模次/时长
  const pairs = {};
  valid.forEach(e => {
    const key = e.machine + '|' + e.code;
    if (!pairs[key]) pairs[key] = { machine: e.machine, code: e.code, byDate: {} };
    const p = pairs[key];
    if (!p.byDate[e.date]) p.byDate[e.date] = { qty: 0, duration: 0 };
    p.byDate[e.date].qty += e.qty;
    p.byDate[e.date].duration += e.duration;
  });

  Object.keys(pairs).sort().forEach(key => {
    const p = pairs[key];
    const dates = Object.keys(p.byDate).sort();
    let segStart = null;
    let segPrev = null;
    let segShots = 0;
    let segDuration = 0;

    const openSeg = (date) => {
      segStart = date; segPrev = date; segShots = 0; segDuration = 0;
      records.push({
        id: `auto_${targetType}_${p.machine}_${p.code}_out_${date}`,
        recordType: 'mold',
        moldId: p.code,
        targetType,
        direction: 'out',
        date,
        machine: p.machine,
        shots: 0,
        duration: 0,
        operator: operatorName,
        notes: '批量生产',
        auto: true
      });
    };
    const closeSeg = (endDate, shots, duration) => {
      records.push({
        id: `auto_${targetType}_${p.machine}_${p.code}_in_${segStart}_${endDate}`,
        recordType: 'mold',
        moldId: p.code,
        targetType,
        direction: 'in',
        date: endDate,
        machine: p.machine,
        shots,
        duration: Math.round(duration * 10) / 10,
        operator: operatorName,
        notes: '批量生产',
        auto: true
      });
    };

    dates.forEach((date, idx) => {
      const day = p.byDate[date];
      if (segStart === null) {
        openSeg(date);
        segShots = day.qty;
        segDuration = day.duration;
        segPrev = date;
      } else {
        const gap = dayDiff(segPrev, date);
        if (gap >= 0 && gap <= 1) {
          // 连续生产：延续周期
          segShots += day.qty;
          segDuration += day.duration;
          segPrev = date;
        } else {
          // 日期间断（机台闲置）：旧周期入库，新周期出库
          closeSeg(segPrev, segShots, segDuration);
          openSeg(date);
          segShots = day.qty;
          segDuration = day.duration;
          segPrev = date;
        }
      }
    });
    // 末尾闭合（机台闲置）
    if (segStart !== null) closeSeg(segPrev, segShots, segDuration);
  });

  // 统一按日期排序，同日出库排在入库前
  records.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  return records;
}

/**
 * 用全量生产事件重建 db.usage 中的自动出入库记录
 * 保留：备件出入库记录（recordType='spare'）、手动记录（manual===true）
 * 同时按入库模次合计重算模具/工装台账累计模次
 * 事件通过 db.__prodEvents 临时传入，重建后删除，不持久化
 */
function rebuildUsage(db) {
  const ev = db.__prodEvents || { mold: [], fixture: [] };
  const old = Array.isArray(db.usage) ? db.usage : [];
  const kept = old.filter(r => r.recordType === 'spare' || r.manual === true);

  const autoMold = buildAutoUsage(ev.mold, 'mold', '孙文敬');
  const autoFixture = buildAutoUsage(ev.fixture, 'fixture', '钟意');

  db.usage = kept.concat(autoMold).concat(autoFixture);

  // 重算台账累计模次 = 该编号全部入库记录（手动+自动）模次之和
  const sumIn = (code) => db.usage
    .filter(r => r.recordType === 'mold' && r.moldId === code && r.direction === 'in')
    .reduce((s, r) => s + (Number(r.shots) || 0), 0);

  (db.molds || []).forEach(m => { if (m && m.code) m.shots = sumIn(m.code); });
  (db.fixtures || []).forEach(f => { if (f && f.code) f.shots = sumIn(f.code); });

  delete db.__prodEvents;
  return { autoMold: autoMold.length, autoFixture: autoFixture.length, kept: kept.length };
}

export async function onRequestGet(context) {
  const kv = context.env.FZ_MOLD_DB;
  if (!kv) {
    return jsonResponse({ error: 'kv_not_bound', message: 'KV namespace not bound' }, 500);
  }
  const data = await readData(kv);
  return jsonResponse({
    version: data.version,
    updatedAt: data.updatedAt,
    db: data.db,
  });
}

export async function onRequestPut(context) {
  const kv = context.env.FZ_MOLD_DB;
  if (!kv) {
    return jsonResponse({ error: 'kv_not_bound', message: 'KV namespace not bound' }, 500);
  }

  const ifVersion = parseInt(context.request.headers.get('If-Version') || '0', 10) || 0;

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_json', message: 'Invalid JSON' }, 400);
  }

  if (!body || !body.db) {
    return jsonResponse({ error: 'missing_db', message: 'Missing db field' }, 400);
  }

  const current = await readData(kv);

  if (current.version > 0 && ifVersion !== current.version) {
    return jsonResponse({
      error: 'conflict',
      version: current.version,
      updatedAt: current.updatedAt,
      db: current.db,
    }, 409);
  }

  const newVersion = current.version + 1;
  const newUpdatedAt = Date.now();
  const newData = {
    version: newVersion,
    updatedAt: newUpdatedAt,
    db: body.db,
    savedBy: body.savedBy || '',
  };

  await writeData(kv, newData);

  return jsonResponse({
    version: newVersion,
    updatedAt: newUpdatedAt,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// 接收生产系统同步的全量生产事件，按使用周期规则重建出入库
// 请求体：
//   { events: { mold: [...], fixture: [...] } }
//   或 { targetType: 'mold'|'fixture', events: [...] }
// 事件字段：{ recordId, date, machine, code, productName, qty, duration, shift }
export async function onRequestPost(context) {
  const kv = context.env.FZ_MOLD_DB;
  if (!kv) {
    return jsonResponse({ error: 'kv_not_bound' }, 500);
  }

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!body || !body.events) {
    return jsonResponse({ error: 'missing_events', message: '缺少 events 全量生产事件' }, 400);
  }

  const current = await readData(kv);
  if (!current.db) {
    return jsonResponse({ error: 'db_empty' }, 500);
  }

  const db = current.db;
  if (!Array.isArray(db.usage)) db.usage = [];

  // 全量重建：生产系统每次推送的是该类型的完整事件集
  db.__prodEvents = { mold: [], fixture: [] };
  if (Array.isArray(body.events) && body.targetType) {
    if (body.targetType === 'fixture' || body.targetType === 'mold') {
      db.__prodEvents[body.targetType] = body.events;
    } else {
      return jsonResponse({ error: 'bad_targetType' }, 400);
    }
  } else if (typeof body.events === 'object') {
    if (Array.isArray(body.events.mold)) db.__prodEvents.mold = body.events.mold;
    if (Array.isArray(body.events.fixture)) db.__prodEvents.fixture = body.events.fixture;
  } else {
    return jsonResponse({ error: 'bad_events' }, 400);
  }

  let stats;
  try {
    stats = rebuildUsage(db);
  } catch (e) {
    console.error('rebuildUsage error:', e);
    return jsonResponse({ error: 'rebuild_failed', message: String(e && e.message || e) }, 500);
  }

  const newVersion = current.version + 1;
  const newData = {
    version: newVersion,
    updatedAt: Date.now(),
    db: db,
    savedBy: '生产系统自动同步'
  };
  await writeData(kv, newData);

  return jsonResponse({ success: true, version: newVersion, stats });
}
