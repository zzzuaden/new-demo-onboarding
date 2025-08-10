// server.js
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// 1) 搜索停车场（支持名称模糊 + 可选半径过滤）
app.get('/api/v1/parking', (req, res) => {
    const { dest = '', lat, lng, radius = 900 } = req.query;

    // 多给几条数据更直观
    const data = [
        { id:'PARK001', name:'Flinders St Car Park',   lat:-37.8183, lng:144.9671, capacity:200, available:35 },
        { id:'PARK002', name:'Fed Square Parking',     lat:-37.8179, lng:144.9691, capacity:150, available:50 },
        { id:'PARK003', name:'QV Melbourne Parking',   lat:-37.8103, lng:144.9643, capacity:500, available:120 },
        { id:'PARK004', name:'Melbourne Central CP',   lat:-37.8107, lng:144.9626, capacity:450, available:80 },
        { id:'PARK005', name:'Southgate Car Park',     lat:-37.8203, lng:144.9657, capacity:300, available:60 }
    ];

    let results = data;

    // 若传了经纬度，则按半径（米）过滤
    if (lat && lng) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const lat0 = parseFloat(lat), lng0 = parseFloat(lng);
        results = results.filter(p => {
            const dLat = toRad(p.lat - lat0);
            const dLng = toRad(p.lng - lng0);
            const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat0))*Math.cos(toRad(p.lat))*Math.sin(dLng/2)**2;
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            const dist = R * c;
            return dist <= Number(radius);
        });
    }

    // 同时支持名称模糊匹配（dest 可与半径一起用）
    const q = dest.toLowerCase().trim();
    if (q) {
        const tokens = q.split(/\s+/).filter(Boolean);
        results = results.filter(p => {
            const name = p.name.toLowerCase();
            return tokens.some(t => name.includes(t));
        });
    }

    res.json(results);
});
// 2) 单个停车场详情
app.get('/api/v1/parking/:id', (req, res) => {
    const { id } = req.params;
    const data = [
        { id:'PARK001', name:'Flinders St Car Park',   lat:-37.8183, lng:144.9671, capacity:200, available:35 },
        { id:'PARK002', name:'Fed Square Parking',     lat:-37.8179, lng:144.9691, capacity:150, available:50 },
        { id:'PARK003', name:'QV Melbourne Parking',   lat:-37.8103, lng:144.9643, capacity:500, available:120 },
        { id:'PARK004', name:'Melbourne Central CP',   lat:-37.8107, lng:144.9626, capacity:450, available:80 },
        { id:'PARK005', name:'Southgate Car Park',     lat:-37.8203, lng:144.9657, capacity:300, available:60 }
    ];
    const found = data.find(p => p.id === id);
    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(found);
});
// 1b) 目的地地名搜索（简单内置表；返回 {items: [...] }）
app.get('/api/v1/geo/search', (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase().trim();
  // Minimal place gazetteer for demo; expand as needed
  const places = [
    { name: 'Flinders Street', lat: -37.8183, lng: 144.9671 },
    { name: 'Flinders St Station', lat: -37.8183, lng: 144.9671 },
    { name: 'Federation Square', lat: -37.8179, lng: 144.9691 },
    { name: 'Melbourne Central', lat: -37.8107, lng: 144.9626 },
    { name: 'QV Melbourne', lat: -37.8103, lng: 144.9643 },
    { name: 'Southgate', lat: -37.8203, lng: 144.9657 },
    { name: 'Collins Street', lat: -37.8189, lng: 144.9675 },
    { name: 'Queen Street', lat: -37.8173, lng: 144.9590 }
  ];
  const items = q ? places.filter(p => p.name.toLowerCase().includes(q)) : places.slice(0, 5);
  res.json({ items });
});
// 2) 环保出行建议
app.get('/api/v1/environment', (req, res) => {
    res.json({
        publicTransport: 'Take Tram 70 from Swanston St, 5 min walk to destination',
        co2SavedKg: 3.5
    });
});

// 3) 停车统计
app.get('/api/v1/stats/parking', (req, res) => {
    res.json({
        averageOccupancy: [
            { carPark: 'Flinders St', percentage: 60 },
            { carPark: 'Fed Square', percentage: 45 }
        ],
        busiestHours: [
            { hour: '08:00', count: 50 },
            { hour: '09:00', count: 80 },
            { hour: '10:00', count: 120 }
        ]
    });
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));