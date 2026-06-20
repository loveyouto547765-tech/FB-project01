// netlify/functions/job-status.js
// GET /.netlify/functions/job-status?jobId=xxx

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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
  if (data.error) throw new Error(data.error);
  return data;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const jobId   = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing jobId' }) };
  try {
    const r = await redisCmd(['GET', `fbpost:${jobId}`]);
    if (!r.result) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
    const job = JSON.parse(r.result);
    delete job.pageToken;
    delete job.imageBase64; // ไม่ส่ง binary กลับ
    return { statusCode: 200, headers, body: JSON.stringify(job) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
