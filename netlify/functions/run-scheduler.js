// netlify/functions/run-scheduler.js
// Scheduled Function ทุก 1 นาที — ตรวจ queue แล้วโพสต์ถึงเวลา

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const FB_API        = 'https://graph.facebook.com/v19.0';

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

async function getJob(jobId) {
  const r = await redisCmd(['GET', `fbpost:${jobId}`]);
  return r.result ? JSON.parse(r.result) : null;
}

async function saveJob(job) {
  await redisCmd(['SET', `fbpost:${job.id}`, JSON.stringify(job)]);
}

async function removeFromQueue(jobId) {
  await redisCmd(['ZREM', 'fbpost:queue', jobId]);
}

async function postArticle(job) {
  const params = new URLSearchParams({ message: job.caption, access_token: job.pageToken });
  const res  = await fetch(`${FB_API}/${job.pageId}/feed`, { method: 'POST', body: params });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.id;
}

async function postImage(job) {
  if (job.imageBase64) {
    // อัพโหลดจาก base64
    const buf = Buffer.from(job.imageBase64, 'base64');
    const fd  = new FormData();
    fd.append('source', new Blob([buf], { type: job.imageMime || 'image/jpeg' }), 'image.jpg');
    fd.append('caption', job.caption);
    fd.append('access_token', job.pageToken);
    const res  = await fetch(`${FB_API}/${job.pageId}/photos`, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.post_id || data.id;
  } else if (job.imageUrl) {
    const params = new URLSearchParams({ url: job.imageUrl, caption: job.caption, access_token: job.pageToken });
    const res  = await fetch(`${FB_API}/${job.pageId}/photos`, { method: 'POST', body: params });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.post_id || data.id;
  }
  throw new Error('ไม่มีข้อมูลรูปภาพ — ต้องการ imageBase64 หรือ imageUrl');
}

async function processJob(jobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== 'pending') return;

  job.status    = 'processing';
  job.startedAt = new Date().toISOString();
  await saveJob(job);

  try {
    let postId;
    if (job.postType === 'article')     postId = await postArticle(job);
    else if (job.postType === 'image')  postId = await postImage(job);
    else if (job.postType === 'reel')   throw new Error('Reel ต้องอัพโหลดไฟล์จากหน้าเว็บโดยตรง');

    job.status    = 'posted';
    job.fbPostId  = String(postId);
    job.postedAt  = new Date().toISOString();
    await saveJob(job);
    await removeFromQueue(jobId);
    console.log(`✓ Posted ${jobId} → ${postId}`);
  } catch (err) {
    job.status    = 'failed';
    job.error     = err.message;
    job.failedAt  = new Date().toISOString();
    await saveJob(job);
    await removeFromQueue(jobId);
    console.error(`✗ Failed ${jobId}:`, err.message);
  }
}

exports.handler = async () => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('Missing UPSTASH env vars');
    return { statusCode: 500, body: 'Redis not configured' };
  }
  try {
    const now = Date.now();
    const r   = await redisCmd(['ZRANGEBYSCORE', 'fbpost:queue', '0', String(now)]);
    const ids = r.result || [];
    if (!ids.length) { console.log('No jobs due'); return { statusCode: 200, body: 'No jobs' }; }
    console.log(`Processing ${ids.length} job(s)…`);
    for (const id of ids) await processJob(id); // sequential เพื่อไม่ให้ rate limit
    return { statusCode: 200, body: `Processed ${ids.length}` };
  } catch (err) {
    console.error('Scheduler error:', err);
    return { statusCode: 500, body: err.message };
  }
};
