const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT = 15000;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

function getProvider(path) {
  if (path.startsWith('/v1/openai')) {
    return {
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
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

function checkProxyKey(req, res, next) {
  const key = req.headers.authorization || '';

  if (!PROXY_API_KEY) {
    return res.status(503).json({
      error: 'PROXY_API_KEY is not configured'
    });
  }

  if (key !== `Bearer ${PROXY_API_KEY}`) {
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
  }, TIMEOUT);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
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
    throw new Error(`Xiaohongshu returned HTTP ${response.status}`);
  }

  const finalUrl = normalizeUrl(response.url) || inputUrl;

  const html = await response.text();

  const match = html.match(
    /window\.__INITIAL_STATE__\s*=\s*({.*?});/
  );

  if (!match) {
    throw new Error(
      'Cannot find note data. The note may require login or may be unavailable.'
    );
  }

  const state = JSON.parse(match[1]);

  const data =
    state.noteData?.data?.noteData ||
    state.noteData?.normalNotePreloadData;

  if (!data) {
    throw new Error(
      'Note data not found. The note may be deleted or require login.'
    );
  }

  const images =
    data.imageList
      ?.map((image) => image.url || image.infoList?.[0]?.url)
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

  const length = Number(response.headers.get('content-length'));

  if (length > MAX_IMAGE_BYTES) {
    return null;
  }

  const buffer = await response.buffer();

  if (buffer.length > MAX_IMAGE_BYTES) {
    return null;
  }

  const mime = response.headers.get('content-type') || 'image/jpeg';
  const base64 = buffer.toString('base64');

  return {
    url: imageUrl.toString(),
    mime,
    base64,
    dataUrl: `data:${mime};base64,${base64}`
  };
}

function findXhsUrl(messages) {
  const text = JSON.stringify(messages);

  const match = text.match(
    /https?:\/\/(?:xhslink\.cn|(?:www\.)?xiaohongshu\.com)\/[^\s"'<>]+/i
  );

  return match ? match[0].replace(/[),.]+$/, '') : null;
}

async function buildXhsMessage(url, question) {
  const note = await parseXhs(url);

  const images = await Promise.all(
    note.images.slice(0, MAX_IMAGES).map(imageToBase64)
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
    .map((comment) => `${comment.user}: ${comment.content}`)
    .join('\n');

  const text = [
    '请根据下面的小红书笔记内容和图片回答用户问题。',
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
    let { messages, temperature = 0.7 } = req.body;

    if (!provider.baseUrl || !provider.apiKey || !provider.model) {
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

        lastUserMessage.content = await buildXhsMessage(
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

app.get('/api/parse', checkProxyKey, async (req, res) => {
  try {
    const note = await parseXhs(req.query.url);

    const images = await Promise.all(
      note.images.slice(0, MAX_IMAGES).map(imageToBase64)
    );

    res.json({
      ok: true,
      note,
      imageData: images.filter(Boolean)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/api/parse', checkProxyKey, async (req, res) => {
  try {
    const note = await parseXhs(req.body.url);

    const images = await Promise.all(
      note.images.slice(0, MAX_IMAGES).map(imageToBase64)
    );

    res.json({
      ok: true,
      note,
      imageData: images.filter(Boolean)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/v1/deepseek/chat/completions', checkProxyKey, chatHandler);
app.post('/v1/openai/chat/completions', checkProxyKey, chatHandler);

app.get('/v1/deepseek/models', checkProxyKey, (req, res) => {
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
});

app.get('/v1/openai/models', checkProxyKey, (req, res) => {
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
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'XHS Preview Service'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
