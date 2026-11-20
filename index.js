const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const REQUEST_TIMEOUT_MS = 15000;
const MAX_IMAGE_COUNT = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const XHS_HOSTS = new Set([
  'xhslink.cn',
  'xiaohongshu.com',
  'www.xiaohongshu.com'
]);

app.use(express.json({ limit: '1mb' }));

// 跨域配置
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// 标准化 URL
function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const input = value.trim().startsWith('//')
      ? `https:${value.trim()}`
      : value.trim();

    const parsed = new URL(input);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

// 只允许小红书域名
function isAllowedXhsHost(hostname) {
  const host = hostname.toLowerCase();

  return (
    XHS_HOSTS.has(host) ||
    host.endsWith('.xiaohongshu.com')
  );
}

// 带超时的请求
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

// 获取小红书笔记信息
app.post('/api/xhs-card', async (req, res) => {
  try {
    const { url } = req.body;
    const noteUrl = normalizeUrl(url);

    if (!noteUrl) {
      return res.status(400).json({
        error: 'Invalid url'
      });
    }

    if (!isAllowedXhsHost(noteUrl.hostname)) {
      return res.status(400).json({
        error: 'Only Xiaohongshu URLs are supported'
      });
    }

    const response = await fetchWithTimeout(noteUrl.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
      }
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Xiaohongshu returned HTTP ${response.status}`
      });
    }

    const html = await response.text();

    const match = html.match(
      /window\.__INITIAL_STATE__\s*=\s*({.*?});/
    );

    if (!match) {
      return res.status(500).json({
        error: 'Cannot find note data'
      });
    }

    const state = JSON.parse(match[1]);

    const noteData =
      state.noteData?.data?.noteData ||
      state.noteData?.normalNotePreloadData;

    if (!noteData) {
      return res.status(500).json({
        error: 'Note data not found'
      });
    }

    const images =
      noteData.imageList
        ?.map((img) => {
          return img.url || img.infoList?.[0]?.url;
        })
        .filter(Boolean) || [];

    res.json({
      ok: true,
      note: {
        title: noteData.title || '',
        author: noteData.user?.nickname || '',
        desc: noteData.desc || '',
        images,
        imageCount: images.length,
        likedCount: noteData.likedCount || 0,
        commentCount: noteData.commentCount || 0,
        collectedCount: noteData.collectedCount || 0,
        comments: (noteData.comments || [])
          .slice(0, 5)
          .map((comment) => ({
            user: comment.user?.nickname || '',
            content: comment.content || '',
            ipLocation: comment.ipLocation || ''
          })),
        url: noteUrl.toString()
      }
    });
  } catch (error) {
    console.error('Error fetching xhs card:', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// 下载图片并转换为 Base64
app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls)) {
      return res.status(400).json({
        error: 'Missing or invalid urls array'
      });
    }

    if (urls.length > MAX_IMAGE_COUNT) {
      return res.status(400).json({
        error: `A maximum of ${MAX_IMAGE_COUNT} images is supported`
      });
    }

    const images = await Promise.all(
      urls.map(async (url) => {
        try {
          const imageUrl = normalizeUrl(url);

          if (!imageUrl || !isAllowedXhsHost(imageUrl.hostname)) {
            return {
              url,
              error: 'Image URL is not allowed'
            };
          }

          const response = await fetchWithTimeout(
            imageUrl.toString()
          );

          if (!response.ok) {
            return {
              url,
              error: `HTTP ${response.status}`
            };
          }

          const contentLength = Number(
            response.headers.get('content-length')
          );

          if (contentLength > MAX_IMAGE_BYTES) {
            return {
              url,
              error: 'Image is too large'
            };
          }

          const buffer = await response.buffer();

          if (buffer.length > MAX_IMAGE_BYTES) {
            return {
              url,
              error: 'Image is too large'
            };
          }

          const base64 = buffer.toString('base64');

          const mime =
            response.headers.get('content-type') ||
            'image/jpeg';

          return {
            url,
            base64,
            mime
          };
        } catch (error) {
          return {
            url,
            error:
              error.name === 'AbortError'
                ? 'Request timed out'
                : error.message
          };
        }
      })
    );

    res.json({
      ok: true,
      images
    });
  } catch (error) {
    console.error('Error fetching xhs images:', error);

    res.status(500).json({
      error: error.message
    });
  }
});

// 健康检查
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'XHS Preview Service'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
