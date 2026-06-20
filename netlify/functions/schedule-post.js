// netlify/functions/schedule-post.js
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ส่งเป็น POST body (ปลอดภัยกว่า URL path สำหรับ value ที่มี special chars)
async function redisCmd(args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data;
}

// Pipeline หลาย commands พร้อมกัน
async function redisPipeline(commands) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  return res.json();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ตรวจ env ก่อน — ถ้าไม่มีให้ return error ชัดเจน
  if (!UPSTASH_URL || !UPSTASH_TOKEN || UPSTASH_URL === 'undefined') {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'Upstash Redis ยังไม่ได้ตั้งค่า — ไปที่ Netlify → Environment variables แล้วเพิ่ม UPSTASH_REDIS_REST_URL และ UPSTASH_REDIS_REST_TOKEN' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { pageId, pageToken, postType, caption, scheduledAt, fileName, imageBase64, imageMime } = body;

    if (!pageId || !pageToken || !scheduledAt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: pageId, pageToken, scheduledAt' }) };
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      pageId,
      pageToken,
      postType: postType || 'article',
      caption: caption || '',
      scheduledAt,
      fileName: fileName || null,
      imageBase64: imageBase64 || null,
      imageMime:   imageMime   || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const score = new Date(scheduledAt).getTime();

    // Pipeline: SET job + ZADD queue ในคำสั่งเดียว
    await redisPipeline([
      ['SET', `fbpost:${jobId}`, JSON.stringify(job)],
      ['ZADD', 'fbpost:queue', score, jobId],
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, jobId, scheduledAt }),
    };
  } catch (err) {
    console.error('schedule-post error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
