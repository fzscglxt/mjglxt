/**
 * 模具管理系统 - 云端数据同步 API (Cloudflare Pages Functions)
 *
 * 接口规范：
 *   GET  /api/db          → 拉取云端最新数据 { version, updatedAt, db }
 *   PUT  /api/db          → 推送本地数据到云端（带 If-Version 头做乐观锁）
 *   OPTIONS /api/db       → CORS 预检
 *
 * KV 存储：
 *   key: "mold_system_db_v1"
 *   value: { version: number, updatedAt: number, db: object, savedBy: string }
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

// 接收生产系统同步的模具使用记录，自动生成出入库
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

  const { machineNo, moldNo, date, productName, qty, duration, targetType } = body;
  if (!machineNo || !moldNo || !date) {
    return jsonResponse({ error: 'missing_params', message: '缺少机台编号、编号或日期' }, 400);
  }

  // 默认是模具，支持工装同步
  const type = targetType || 'mold';

  const current = await readData(kv);
  if (!current.db) {
    return jsonResponse({ error: 'db_empty' }, 500);
  }

  const db = current.db;
  if (!db.usageRecords) db.usageRecords = [];

  // 生成唯一ID
  function uid() {
    return 'usage_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // 1. 找到这个机台上最近一次使用的（模具/工装）
  const machineUsage = db.usageRecords
    .filter(r => r.recordType === 'mold' && r.targetType === type && r.machine === machineNo)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const lastMoldOnMachine = machineUsage.length > 0 ? machineUsage[0].moldId : null;

  // 2. 如果机台上原来有旧的，且和这次的不一样，给旧的生成入库记录
  let oldMoldInRecord = null;
  if (lastMoldOnMachine && lastMoldOnMachine !== moldNo) {
    // 检查旧的最近一条记录是不是已经入库了
    const oldMoldRecords = db.usageRecords
      .filter(r => r.recordType === 'mold' && r.targetType === type && r.moldId === lastMoldOnMachine)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const oldMoldLastDir = oldMoldRecords.length > 0 ? oldMoldRecords[0].direction : null;

    if (oldMoldLastDir !== 'in') {
      oldMoldInRecord = {
        id: uid(),
        recordType: 'mold',
        moldId: lastMoldOnMachine,
        targetType: type,
        direction: 'in',
        date: date,
        machine: machineNo,
        shots: 0,
        duration: 0,
        operator: '生产系统自动同步',
        notes: `生产系统自动入库：机台${machineNo}切换${type === 'fixture' ? '工装' : '模具'}`
      };
      db.usageRecords.push(oldMoldInRecord);
    }
  }

  // 3. 给新的生成出库记录（如果最近一条不是出库）
  const newMoldRecords = db.usageRecords
    .filter(r => r.recordType === 'mold' && r.targetType === type && r.moldId === moldNo)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const newMoldLastDir = newMoldRecords.length > 0 ? newMoldRecords[0].direction : null;

  let newMoldOutRecord = null;
  if (newMoldLastDir !== 'out') {
    newMoldOutRecord = {
      id: uid(),
      recordType: 'mold',
      moldId: moldNo,
      targetType: type,
      direction: 'out',
      date: date,
      machine: machineNo,
      shots: 0,
      duration: duration || 0,
      operator: '生产系统自动同步',
      notes: `生产系统自动出库：生产产品${productName || ''}，数量${qty || 0}`
    };
    db.usageRecords.push(newMoldOutRecord);
  }

  // 写回KV
  const newVersion = current.version + 1;
  const newData = {
    version: newVersion,
    updatedAt: Date.now(),
    db: db,
    savedBy: '生产系统自动同步'
  };
  await writeData(kv, newData);

  return jsonResponse({
    success: true,
    oldMoldInRecord: oldMoldInRecord,
    newMoldOutRecord: newMoldOutRecord,
    version: newVersion
  });
}
