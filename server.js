require('dotenv').config({ path: '.env.local' });
const express = require('express');
const cors = require('cors');
const fetchRss = require('./api/fetch-rss');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 요청 로깅 미들웨어
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    console.log('Headers:', req.headers);
    next();
});

// API 라우트
app.get('/api/fetch-rss', async (req, res) => {
    console.log('RSS 업데이트 요청 받음');
    try {
        await fetchRss(req, res);
    } catch (error) {
        console.error('API 처리 중 오류:', error);
        res.status(500).json({ error: '서버 내부 오류', details: error.message });
    }
});

// 404 처리
app.use((req, res) => {
    console.log(`404 - Not Found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Not Found' });
});

// 에러 처리
app.use((err, req, res, next) => {
    console.error('서버 에러:', err);
    res.status(500).json({ error: '서버 내부 오류', details: err.message });
});

app.listen(port, () => {
    console.log(`API 서버가 http://localhost:${port} 에서 실행 중입니다.`);
}); 