const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1. 抓取笔记数据
app.post('/api/xhs-card', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
      }
    });
    const html = await response.text();

    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/);
    if (!match) return res.status(500).json({ error: 'Cannot find note data' });

    const state = JSON.parse(match[1]);
    const noteData = state.noteData?.data?.noteData || state.noteData?.normalNotePreloadData;
    if (!noteData) return res.status(500).json({ error: 'Note data not found' });

    const images = noteData.imageList?.map(img => img.url || img.infoList?.[0]?.url).filter(Boolean) || [];
    const imageCount = images.length;

    res.json({
      ok: true,
      note: {
        title: noteData.title || '',
        author: noteData.user?.nickname || '',
        desc: noteData.desc || '',
        images,
        imageCount,
        likedCount: noteData.likedCount || 0,
        commentCount: noteData.commentCount || 0,
        collectedCount: noteData.collectedCount || 0,
        comments: (noteData.comments || []).slice(0, 5).map(c => ({
          user: c.user?.nickname,
          content: c.content,
          ipLocation: c.ipLocation
        })),
        url
      }
    });
  } catch (err) {
    console.error('Error fetching xhs card:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. 下载图片并转 base64
app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({ error: 'Missing or invalid urls array' });
    }

    const images = [];
    for (const url of urls) {
      try {
        const fullUrl = url.startsWith('//') ? 'https:' + url : url;
        const response = await fetch(fullUrl);
        if (!response.ok) {
          images.push({ url, error: `HTTP ${response.status}` });
          continue;
        }
        const buffer = await response.buffer();
        const base64 = buffer.toString('base64');
        const mime = response.headers.get('content-type') || 'image/jpeg';
        images.push({ url, base64, mime });
      } catch (err) {
        images.push({ url, error: err.message });
      }
    }

    res.json({ ok: true, images });
  } catch (err) {
    console.error('Error fetching xhs images:', err);
    res.status(500).json({ error: err.message });
  }
});

// 健康检查
app.get('/', (req, res) => {
  res.send('XHS Preview Service is running.');
});

// 健康检查
app.get('/', (req, res) => {
  res.send('XHS Preview Service is running.');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
