const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT = 15000;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

function getProvider(pathname) {
  if (pathname.startsWith('/v1/openai')) {
    return {
      baseUrl: (process.env.OPENAI_BASE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || ''
    };
  }

  return {
    baseUrl: (process.env.DEEPSEEK_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || ''
  };
}

function requireProxyKey(req, res, next) {
  if (!PROXY_API_KEY) {
    return res.status(503).json({
      error: 'PROXY_API_KEY is not configured'
    });
  }

  const authorization = req.headers.authorization || '';

  if (authorization !== `Bearer ${PROXY_API_KEY}`) {
    return res.status(401).json({
      error: 'Invalid API key'
    });
  }

  next();
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());

    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function isXhsHost(hostname) {
  const host = hostname.toLowerCase();

  return (
    host === 'xhslink.cn' ||
    host === 'xiaohongshu.com' ||
    host === 'www.xiaohongshu.com' ||
    host.endsWith('.xiaohongshu.com')
  );
}

async function request(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function findXhsUrl(messages) {
  const text = JSON.stringify(messages);

  const match = text.match(
    /https?:\/\/(?:xhslink\.cn|(?:www\.)?xiaohongshu\.com)\/[^\s"'<>]+/i
  );

  return match ? match[0].replace(/[),.]+$/, '') : null;
}

function readInitialState(html) {
  const match = html.match(
    /window\.__INITIAL_STATE__\s*=\s*/
  );

  if (!match || match.index === undefined) {
    return null;
  }

  const jsonStart = match.index + match[0].length;
  const scriptEnd = html.indexOf('</script>', jsonStart);

  if (scriptEnd < 0) {
    return null;
  }

  let jsonText = html
    .slice(jsonStart, scriptEnd)
    .trim();

  if (jsonText.endsWith(';')) {
    jsonText = jsonText.slice(0, -1);
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    console.error('Cannot parse XHS state:', error.message);
    return null;
  }
}

function readMeta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const hasName =
      new RegExp(
        `(?:name|property)=["']${key}["']`,
        'i'
      ).test(tag);

    if (!hasName) {
      continue;
    }

    const content = tag.match(
      /content=["']([^"']*)["']/i
    );

    if (content) {
      return content[1];
    }
  }

  return '';
}

async function parseXhs(url) {
  const inputUrl = normalizeUrl(url);

  if (!inputUrl || !isXhsHost(inputUrl.hostname)) {
    throw new Error('Only Xiaohongshu URLs are supported');
  }

  const response = await request(inputUrl.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Xiaohongshu returned HTTP ${response.status}`
    );
  }

  const finalUrl = normalizeUrl(response.url) || inputUrl;

  const html = await response.text();
  const state = readInitialState(html);

  let data =
    state?.noteData?.data?.noteData ||
    state?.noteData?.normalNotePreloadData;

  // 如果初始状态读取失败，则使用网页公开的 meta 信息兜底
  if (!data) {
    const title =
      readMeta(html, 'og:title') ||
      html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] ||
      '';

    const desc =
      readMeta(html, 'og:description') ||
      readMeta(html, 'description') ||
      '';

    const image = readMeta(html, 'og:image');

    if (title || desc || image) {
      data = {
        title,
        desc,
        user: {},
        imageList: image ? [{ url: image }] : [],
        comments: []
      };
    }
  }

  if (!data) {
    throw new Error(
      'Cannot find note data. The note may require login or may be unavailable.'
    );
  }

  const images =
    data.imageList
      ?.map((image) => {
        return image.url || image.infoList?.[0]?.url;
      })
      .filter(Boolean) || [];

  const comments = (data.comments || [])
    .slice(0, 20)
    .map((comment) => ({
      user: comment.user?.nickname || '',
      content: comment.content || '',
      ipLocation: comment.ipLocation || ''
    }));

  return {
    url: finalUrl.toString(),
    title: data.title || '',
    author: data.user?.nickname || '',
    desc: data.desc || '',
    images,
    imageCount: images.length,
    likedCount: data.likedCount || 0,
    commentCount: data.commentCount || 0,
    collectedCount: data.collectedCount || 0,
    comments
  };
}

async function imageToBase64(url) {
  const imageUrl = normalizeUrl(url);

  if (!imageUrl || !isXhsHost(imageUrl.hostname)) {
    return null;
  }

  const response = await request(imageUrl.toString());

  if (!response.ok) {
    return null;
  }

  const contentLength = Number(
    response.headers.get('content-length')
  );

  if (contentLength > MAX_IMAGE_BYTES) {
    return null;
  }

  const buffer = await response.buffer();

  if (buffer.length > MAX_IMAGE_BYTES) {
    return null;
  }

  const mime =
    response.headers.get('content-type') || 'image/jpeg';

  const base64 = buffer.toString('base64');

  return {
    url: imageUrl.toString(),
    mime,
    base64,
    dataUrl: `data:${mime};base64,${base64}`
  };
}

async function buildXhsMessage(url, question) {
  const note = await parseXhs(url);

  const images = await Promise.all(
    note.images
      .slice(0, MAX_IMAGES)
      .map(imageToBase64)
  );

  const imageBlocks = images
    .filter(Boolean)
    .map((image) => ({
      type: 'image_url',
      image_url: {
        url: image.dataUrl
      }
    }));

  const commentText = note.comments
    .map((comment) => {
      return `${comment.user}: ${comment.content}`;
    })
    .join('\n');

  const text = [
    '请根据下面的小红书笔记内容、图片和评论回答用户问题。',
    `标题：${note.title}`,
    `作者：${note.author}`,
    `正文：${note.desc}`,
    `评论区：${commentText}`,
    `原链接：${note.url}`,
    '',
    `用户问题：${question}`
  ].join('\n');

  return [
    {
      type: 'text',
      text
    },
    ...imageBlocks
  ];
}

async function chatHandler(req, res) {
  try {
    const provider = getProvider(req.path);
    let {
      messages,
      temperature = 0.7
    } = req.body;

    if (
      !provider.baseUrl ||
      !provider.apiKey ||
      !provider.model
    ) {
      return res.status(503).json({
        error: 'AI provider is not configured'
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'messages must be a non-empty array'
      });
    }

    const xhsUrl = findXhsUrl(messages);

    if (xhsUrl) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'user');

      if (lastUserMessage) {
        const question =
          typeof lastUserMessage.content === 'string'
            ? lastUserMessage.content
            : JSON.stringify(lastUserMessage.content);

        lastUserMessage.content =
          await buildXhsMessage(
            xhsUrl,
            question
          );
      }
    }

    const response = await request(
      `${provider.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature,
          stream: false
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        error:
          result.error?.message ||
          `AI service returned HTTP ${response.status}`
      });
    }

    res.json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        error.name === 'AbortError'
          ? 'Request timed out'
          : error.message
    });
  }
}

async function parseHandler(req, res) {
  try {
    const url =
      req.method === 'GET'
        ? req.query.url
        : req.body.url;

    const note = await parseXhs(url);

    const imageData = (
      await Promise.all(
        note.images
          .slice(0, MAX_IMAGES)
          .map(imageToBase64)
      )
    ).filter(Boolean);

    res.json({
      ok: true,
      note,
      imageData
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
}

app.get('/api/parse', requireProxyKey, parseHandler);
app.post('/api/parse', requireProxyKey, parseHandler);

app.post('/api/xhs-card', async (req, res) => {
  try {
    const note = await parseXhs(req.body.url);

    res.json({
      ok: true,
      note
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls)) {
      return res.status(400).json({
        error: 'urls must be an array'
      });
    }

    const images = await Promise.all(
      urls.slice(0, MAX_IMAGES).map(async (url) => {
        const image = await imageToBase64(url);

        if (!image) {
          return {
            url,
            error: 'Unable to download image'
          };
        }

        return {
          url: image.url,
          mime: image.mime,
          base64: image.base64
        };
      })
    );

    res.json({
      ok: true,
      images
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post(
  '/v1/deepseek/chat/completions',
  requireProxyKey,
  chatHandler
);

app.post(
  '/v1/openai/chat/completions',
  requireProxyKey,
  chatHandler
);

app.get(
  '/v1/deepseek/models',
  requireProxyKey,
  (req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: process.env.DEEPSEEK_MODEL || '',
          object: 'model',
          owned_by: 'custom'
        }
      ]
    });
  }
);

app.get(
  '/v1/openai/models',
  requireProxyKey,
  (req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: process.env.OPENAI_MODEL || '',
          object: 'model',
          owned_by: 'custom'
        }
      ]
    });
  }
);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'XHS Preview Service'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
