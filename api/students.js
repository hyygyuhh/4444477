/**
 * 飞书多维表格代理函数
 * 部署在 Vercel Serverless 上，持有 App Secret，前端不暴露密钥
 * 前端通过 /api/students 调用，本函数转发到飞书 OpenAPI
 */

// ===== 飞书应用凭证（部署后只有 Vercel 服务器能看到，前端看不到）=====
const APP_ID = 'cli_aaf1bbb2a8b89beb';
const APP_SECRET = 'UIKVSoyKqpmmUEnwRufYMc3IflHqK0RH';

// ===== 飞书多维表格配置 =====
const BASE_TOKEN = 'Gjz7wOLmkigSRVkFgG9cX6aJnvh';  // 多维表格 token
const TABLE_ID = 'tblWwlULHkUyjPSJ';                  // 数据表 ID

// 缓存 tenant_access_token（有效期2小时，避免频繁请求）
let cachedToken = null;
let tokenExpireAt = 0;

/**
 * 获取飞书 tenant_access_token
 */
async function getToken() {
  if (cachedToken && Date.now() < tokenExpireAt) {
    return cachedToken;
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('获取token失败: ' + data.msg);
  cachedToken = data.tenant_access_token;
  // 提前5分钟过期，留安全余量
  tokenExpireAt = Date.now() + (data.expire - 300) * 1000;
  return cachedToken;
}

/**
 * 飞书字段名与前端字段名的映射
 * 前端用英文 key，飞书用中文字段名
 */
const FIELD_MAP = {
  'studentName': '学生姓名',
  'classTime': '上课时间段',
  'classNo': '班级编号',
  'parentPhone': '家长电话',
  'coachName': '授课教练',
  'totalHours': '总购买课时',
  'usedHours': '已上课时',
};

/** 前端格式 → 飞书格式 */
function toFeishu(record) {
  const fields = {};
  for (const [en, cn] of Object.entries(FIELD_MAP)) {
    if (record[en] !== undefined && record[en] !== null) {
      fields[cn] = record[en];
    }
  }
  return { fields };
}

/** 飞书格式 → 前端格式 */
function fromFeishu(record) {
  const f = record.fields || {};
  return {
    id: record.record_id || record.id,
    studentName: f['学生姓名'] || '',
    classTime: f['上课时间段'] || '',
    classNo: f['班级编号'] || '',
    parentPhone: f['家长电话'] || '',
    coachName: f['授课教练'] || '',
    totalHours: f['总购买课时'] || 0,
    usedHours: f['已上课时'] || 0,
  };
}

/**
 * Vercel Serverless 主函数
 * 路由：
 *   GET    /api/students          → 获取全部学员
 *   POST   /api/students          → 新增学员
 *   PUT    /api/students?id=xxx   → 更新学员
 *   DELETE /api/students?id=xxx   → 删除学员
 */
export default async function handler(req, res) {
  // 允许跨域（部署后可限制为你的域名）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const token = await getToken();
    const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`;

    // ===== GET: 获取全部学员 =====
    if (req.method === 'GET') {
      let allRecords = [];
      let pageToken = undefined;
      // 分页拉取（每页100条）
      do {
        const url = new URL(baseUrl);
        url.searchParams.set('page_size', '100');
        if (pageToken) url.searchParams.set('page_token', pageToken);
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await resp.json();
        if (data.code !== 0) throw new Error(data.msg);
        allRecords = allRecords.concat(data.data.items || []);
        pageToken = data.data.has_more ? data.data.page_token : undefined;
      } while (pageToken);

      return res.status(200).json({
        ok: true,
        data: allRecords.map(fromFeishu),
      });
    }

    // ===== POST: 新增学员（单个或批量） =====
    if (req.method === 'POST') {
      const body = req.body;

      // 批量新增：POST /api/students?batch=true，body 为数组
      if (req.query.batch === 'true' && Array.isArray(body)) {
        const batchUrl = `${baseUrl}/batch_create`;
        const payload = {
          records: body.map(toFeishu),
        };
        const resp = await fetch(batchUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (data.code !== 0) throw new Error(data.msg);
        const records = (data.data.records || []).map(fromFeishu);
        return res.status(200).json({ ok: true, data: records });
      }

      // 单个新增
      const resp = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toFeishu(body)),
      });
      const data = await resp.json();
      if (data.code !== 0) throw new Error(data.msg);
      return res.status(200).json({ ok: true, data: fromFeishu(data.data.record) });
    }

    // ===== PUT: 更新学员 =====
    if (req.method === 'PUT') {
      const id = req.query.id;
      if (!id) throw new Error('缺少 record id');
      const body = req.body;
      const resp = await fetch(`${baseUrl}/${id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toFeishu(body)),
      });
      const data = await resp.json();
      if (data.code !== 0) throw new Error(data.msg);
      return res.status(200).json({ ok: true, data: fromFeishu(data.data.record) });
    }

    // ===== DELETE: 删除学员 =====
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) throw new Error('缺少 record id');
      const resp = await fetch(`${baseUrl}/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await resp.json();
      if (data.code !== 0) throw new Error(data.msg);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: '不支持的请求方法' });
  } catch (err) {
    console.error('API错误:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
