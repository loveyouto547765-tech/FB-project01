// netlify/functions/fb-proxy.js
// Proxy ส่งต่อ request ไป Facebook Graph API
// รองรับ: text post, photo, reel chunked upload + scheduled_publish_time

const https = require("https");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// POST ไปยัง Facebook Graph API
function fbPOST(path, bodyStr, contentType) {
  return new Promise((resolve, reject) => {
    const ct = contentType || "application/x-www-form-urlencoded";
    const buf = Buffer.from(bodyStr, ct.includes("base64") ? "base64" : "utf8");
    const opts = {
      hostname: "graph.facebook.com",
      path: path.startsWith("/") ? path : "/" + path,
      method: "POST",
      headers: { "Content-Type": ct, "Content-Length": buf.length },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

// GET ไปยัง Facebook Graph API
function fbGET(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "graph.facebook.com",
      path: path.startsWith("/") ? path : "/" + path,
      method: "GET",
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// POST multipart/form-data ไป graph-video.facebook.com (สำหรับ chunk upload)
function fbVideoChunk(uploadUrl, chunkBuf, startOffset, totalSize, uploadSessionId, token) {
  return new Promise((resolve, reject) => {
    const boundary = "----FBChunk" + Date.now();
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="upload_phase"\r\n\r\ntransfer`,
      `--${boundary}\r\nContent-Disposition: form-data; name="start_offset"\r\n\r\n${startOffset}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="upload_session_id"\r\n\r\n${uploadSessionId}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${token}`,
    ];
    const prelude = parts.join("\r\n") + "\r\n";
    const videoHeader = `--${boundary}\r\nContent-Disposition: form-data; name="video_file_chunk"; filename="chunk.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
    const epilogue = `\r\n--${boundary}--\r\n`;
    const preBuf = Buffer.from(prelude + videoHeader, "utf8");
    const epiBuf = Buffer.from(epilogue, "utf8");
    const body = Buffer.concat([preBuf, chunkBuf, epiBuf]);

    const urlObj = new URL(uploadUrl);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function enc(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: "Method not allowed" } }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: "Invalid JSON" } }) }; }

  const { action, pageId, token } = body;

  try {
    // ── TEXT POST ──────────────────────────────────────────
    if (action === "post_text") {
      const { message, scheduledTime } = body;
      const params = { message, access_token: token };
      if (scheduledTime) {
        params.scheduled_publish_time = String(scheduledTime);
        params.published = "false";
      }
      const res = await fbPOST(`/v19.0/${pageId}/feed`, enc(params));
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    // ── PHOTO POST ─────────────────────────────────────────
    if (action === "post_photo") {
      const { imageBase64, imageMime, caption, scheduledTime } = body;
      if (!imageBase64) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: "imageBase64 required" } }) };
      const buf = Buffer.from(imageBase64, "base64");
      const boundary = "----FBPhoto" + Date.now();
      const pre = [
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption || ""}`,
        `--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${token}`,
        scheduledTime ? `--${boundary}\r\nContent-Disposition: form-data; name="scheduled_publish_time"\r\n\r\n${scheduledTime}` : null,
        scheduledTime ? `--${boundary}\r\nContent-Disposition: form-data; name="published"\r\n\r\nfalse` : null,
      ].filter(Boolean).join("\r\n") + "\r\n";
      const imgHeader = `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="photo.jpg"\r\nContent-Type: ${imageMime || "image/jpeg"}\r\n\r\n`;
      const epi = `\r\n--${boundary}--\r\n`;
      const fullBuf = Buffer.concat([Buffer.from(pre + imgHeader, "utf8"), buf, Buffer.from(epi, "utf8")]);

      const res = await new Promise((resolve, reject) => {
        const opts = {
          hostname: "graph.facebook.com",
          path: `/v19.0/${pageId}/photos`,
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": fullBuf.length },
        };
        const req = https.request(opts, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
        req.on("error", reject); req.write(fullBuf); req.end();
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    // ── REEL: Step 1 — Init upload session ────────────────
    if (action === "reel_init") {
      const { fileSize } = body;
      const res = await fbGET(`/v19.0/${pageId}/video_reels?upload_phase=start&file_size=${fileSize}&access_token=${token}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    // ── REEL: Step 2 — Upload chunk (base64 encoded) ──────
    if (action === "reel_chunk") {
      const { uploadUrl, chunkBase64, startOffset, totalSize, uploadSessionId } = body;
      if (!chunkBase64) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: "chunkBase64 required" } }) };
      const chunkBuf = Buffer.from(chunkBase64, "base64");
      const res = await fbVideoChunk(uploadUrl, chunkBuf, startOffset, totalSize, uploadSessionId, token);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    // ── REEL: Step 3 — Finish + publish / schedule ────────
    if (action === "reel_finish") {
      const { uploadSessionId, description, scheduledTime } = body;
      const params = {
        upload_phase: "finish",
        upload_session_id: uploadSessionId,
        video_state: scheduledTime ? "SCHEDULED" : "PUBLISHED",
        description: description || "",
        access_token: token,
      };
      if (scheduledTime) params.scheduled_publish_time = String(scheduledTime);
      const res = await fbPOST(`/v19.0/${pageId}/video_reels`, enc(params));
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    // ── GET PAGE POSTS ─────────────────────────────────────
    if (action === "get_posts") {
      const res = await fbGET(`/v19.0/${pageId}/posts?fields=id,message,story,created_time,likes.summary(true),comments.summary(true),shares&limit=10&access_token=${token}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    // ── GET PAGE INFO ──────────────────────────────────────
    if (action === "get_page_info") {
      const res = await fbGET(`/v19.0/me/accounts?fields=id,name,access_token,picture.type(large)&access_token=${token}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: "Unknown action: " + action } }) };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
