const express = require("express");
const sqlite3 = require("sqlite3-offline").verbose();
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const db = new sqlite3.Database("./poultry_farm.db");

// تهيئة قاعدة البيانات وإنشاء الجداول السبعة
db.serialize(() => {
  // 1. جدول المستخدمين والصلاحيات
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);

  // 2. جدول العنابر
  db.run(`CREATE TABLE IF NOT EXISTS barns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    capacity INTEGER,
    initial_chicks INTEGER,
    start_date TEXT,
    breed TEXT
  )`);

  // 3. جدول السجل اليومي
  db.run(`CREATE TABLE IF NOT EXISTS daily_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barn_id INTEGER,
    record_date TEXT,
    age INTEGER,
    feed_morning REAL,
    feed_evening REAL,
    water_liters REAL,
    mortality_morning INTEGER,
    mortality_evening INTEGER,
    sold_count INTEGER,
    internal_use INTEGER,
    culled_count INTEGER,
    FOREIGN KEY(barn_id) REFERENCES barns(id)
  )`);

  // 4. جدول الأصناف والمخزون
  db.run(`CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT UNIQUE,
    category TEXT,
    current_balance REAL,
    unit TEXT
  )`);

  // 5. جدول حركات المخزون
  db.run(`CREATE TABLE IF NOT EXISTS stock_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    tx_type TEXT, -- 'IN' أو 'OUT'
    quantity REAL,
    tx_date TEXT,
    FOREIGN KEY(item_id) REFERENCES stock(id)
  )`);

  // 6. جدول الأوزان الأسبوعية والتناسق
  db.run(`CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barn_id INTEGER,
    week_number INTEGER,
    sample_size INTEGER,
    avg_weight REAL,
    uniformity REAL,
    standard_deviation REAL,
    record_date TEXT,
    FOREIGN KEY(barn_id) REFERENCES barns(id)
  )`);

  // 7. جدول التنبيهات الذكية
  db.run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barn_id INTEGER,
    alert_type TEXT,
    message TEXT,
    severity TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TEXT
  )`);

  // إدخال بيانات افتراضية للمستخدمين والمخزون والعنابر عند التشغيل الأول
  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO users (username, password, role) VALUES ('admin', 'admin', 'مدير')");
      db.run("INSERT INTO users (username, password, role) VALUES ('supervisor', '1234', 'مشرف')");
      db.run("INSERT INTO users (username, password, role) VALUES ('worker', '1234', 'عامل')");
      
      // إضافة 4 عنابر افتراضية كـ ستارت أب للدورة
      const today = new Date().toISOString().split('T')[0];
      db.run(`INSERT INTO barns (code, capacity, initial_chicks, start_date, breed) VALUES 
        ('عنبر 1 مغلق', 10000, 9800, '${today}', 'Cobb 500'),
        ('عنبر 2 مغلق', 10000, 10000, '${today}', 'Ross 308'),
        ('عنبر 3 مغلق', 12000, 11500, '${today}', 'Ross 308'),
        ('عنبر 4 مغلق', 12000, 12000, '${today}', 'Indian River')`);

      // تهيئة الأصناف الأربعة الأساسية في المخزون
      db.run("INSERT INTO stock (item_name, category, current_balance, unit) VALUES ('علف بادي Starter', 'علف', 5000, 'كجم')");
      db.run("INSERT INTO stock (item_name, category, current_balance, unit) VALUES ('علف نامي Grower', 'علف', 10000, 'كجم')");
      db.run("INSERT INTO stock (item_name, category, current_balance, unit) VALUES ('علف ناهي Finisher', 'علف', 0, 'كجم')");
      db.run("INSERT INTO stock (item_name, category, current_balance, unit) VALUES ('نشارة ناعمة', 'نشارة', 200, 'شيكارة')");
    }
  });
});

// --- مسارات الـ API للربط البرمجي الكامل ---

// تسجيل الدخول والتحقق من الصلاحيات
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
    if (row) { res.send({ success: true, role: row.role, username: row.username }); }
    else { res.status(401).send({ success: false, message: "بيانات الاعتماد غير صحيحة" }); }
  });
});

// جلب كل العنابر مع الحسابات التلقائية (العدد الحالي، النفوق، نسبة الإشغال)
app.get("/api/barns", (req, res) => {
  db.all(`
    SELECT b.*, 
    IFNULL((SELECT SUM(mortality_morning + mortality_evening + culled_count) FROM daily_records WHERE barn_id = b.id), 0) as total_dead,
    IFNULL((SELECT SUM(sold_count + internal_use) FROM daily_records WHERE barn_id = b.id), 0) as total_out
    FROM barns b
  `, [], (err, rows) => {
    if (err) return res.status(500).send(err);
    const updatedRows = rows.map(barn => {
      const current_count = barn.initial_chicks - barn.total_dead - barn.total_out;
      const mortality_rate = barn.initial_chicks > 0 ? ((barn.total_dead / barn.initial_chicks) * 100).toFixed(2) : 0;
      const occupancy_rate = barn.capacity > 0 ? ((current_count / barn.capacity) * 100).toFixed(2) : 0;
      return { ...barn, current_count, mortality_rate, occupancy_rate };
    });
    res.send(updatedRows);
  });
});

// إضافة عنبر جديد ديناميكياً
app.post("/api/barns", (req, res) => {
  const { code, capacity, initial_chicks, start_date, breed } = req.body;
  db.run("INSERT INTO barns (code, capacity, initial_chicks, start_date, breed) VALUES (?, ?, ?, ?, ?)",
    [code, capacity, initial_chicks, start_date, breed], function(err) {
      if (err) return res.status(500).send(err);
      res.send({ id: this.lastID });
    });
});

// إضافة سجل يومي ذكي مع معالجة الخصم من المخزون التلقائي والتحليل الأوتوماتيكي للنفوق والعلف
app.post("/api/daily-records", (req, res) => {
  const { barn_id, record_date, feed_morning, feed_evening, water_liters, mortality_morning, mortality_evening, sold_count, internal_use, culled_count, feed_type } = req.body;
  
  // حساب عمر الطيور تلقائياً بناء على تاريخ بداية الدورة
  db.get("SELECT start_date, initial_chicks FROM barns WHERE id = ?", [barn_id], (err, barn) => {
    if (!barn) return res.status(404).send("العنبر غير موجود");
    
    const diffTime = Math.abs(new Date(record_date) - new Date(barn.start_date));
    const age = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    
    db.run(`INSERT INTO daily_records (barn_id, record_date, age, feed_morning, feed_evening, water_liters, mortality_morning, mortality_evening, sold_count, internal_use, culled_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barn_id, record_date, age, feed_morning, feed_evening, water_liters, mortality_morning, mortality_evening, sold_count, internal_use, culled_count],
      function(err) {
        if (err) return res.status(500).send(err);
        
        const total_feed = parseFloat(feed_morning) + parseFloat(feed_evening);
        const daily_dead = parseInt(mortality_morning) + parseInt(mortality_evening);
        
        // الخصم التلقائي من المخزون للأعلاف
        if (total_feed > 0 && feed_type) {
          db.run("UPDATE stock SET current_balance = current_balance - ? WHERE item_name = ?", [total_feed, feed_type]);
        }

        // المحرك الذكي: فحص التنبيهات اللحظية (النفوق أو انخفاض العلف الشاذ)
        // إذا تعدى النفوق اليومي نسبة شاذة (> 0.5% في يوم واحد أو الإجمالي المتراكم تجاوز المقاييس)
        const dead_percentage = (daily_dead / barn.initial_chicks) * 100;
        if (dead_percentage > 0.5) {
          db.run("INSERT INTO alerts (barn_id, alert_type, message, severity, created_at) VALUES (?, 'نفوق حاد', ?, 'High', ?)",
            [barn_id, `تنبيه حاد: النفوق اليومي في ${record_date} تخطى العتبة الآمنة بـ (${dead_percentage.toFixed(2)}%)!`, record_date]);
        }
        
        res.send({ success: true, record_id: this.lastID, calculated_age: age });
      }
    );
  });
});

// جلب حركات المخزون والتحليلات التنبؤية (أيام النفاد المتوقعة)
app.get("/api/stock", (req, res) => {
  db.all("SELECT * FROM stock", [], (err, rows) => {
    if (err) return res.status(500).send(err);
    // حساب تقريبي لأيام النفاد بناءً على معدل استهلاك افتراضي دوري لعنابر التسمين الحديثة
    const analyzedStock = rows.map(item => {
      let daily_burn = item.category === 'علف' ? 450 : 5; // معدل استهلاك قياسي متغير
      let days_to_depletion = item.current_balance > 0 ? Math.ceil(item.current_balance / daily_burn) : 0;
      return { ...item, daily_burn, days_to_depletion };
    });
    res.send(analyzedStock);
  });
});

// إضافة حركة مخزون جديدة (وارد شحنات)
app.post("/api/stock/transaction", (req, res) => {
  const { item_id, tx_type, quantity, tx_date } = req.body;
  db.run("INSERT INTO stock_transactions (item_id, tx_type, quantity, tx_date) VALUES (?, ?, ?, ?)",
    [item_id, tx_type, quantity, tx_date], function(err) {
      if (err) return res.status(500).send(err);
      const sign = tx_type === 'IN' ? 1 : -1;
      db.run("UPDATE stock SET current_balance = current_balance + ? WHERE id = ?", [quantity * sign, item_id], (err2) => {
        res.send({ success: true });
      });
    });
});

// جلب وإدخال أوزان العينات لحساب التناسق والإنحراف المعياري لكتالوجات الـ Ross/Cobb
app.post("/api/weights", (req, res) => {
  const { barn_id, week_number, sample_size, avg_weight, uniformity, standard_deviation, record_date } = req.body;
  db.run(`INSERT INTO weights (barn_id, week_number, sample_size, avg_weight, uniformity, standard_deviation, record_date)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [barn_id, week_number, sample_size, avg_weight, uniformity, standard_deviation, record_date], function(err) {
      if (err) return res.status(500).send(err);
      res.send({ success: true });
    });
});

app.get("/api/analytics/:barn_id", (req, res) => {
  const barn_id = req.params.barn_id;
  db.get("SELECT initial_chicks FROM barns WHERE id = ?", [barn_id], (err, barn) => {
    db.all("SELECT * FROM daily_records WHERE barn_id = ? ORDER BY age ASC", [barn_id], (err2, records) => {
      db.all("SELECT * FROM weights WHERE barn_id = ? ORDER BY week_number ASC", [barn_id], (err3, weightRecords) => {
        
        let total_feed_consumed = 0;
        let current_dead = 0;
        records.forEach(r => {
          total_feed_consumed += (r.feed_morning + r.feed_evening);
          current_dead += (r.mortality_morning + r.mortality_evening + r.culled_count);
        });

        const latest_weight = weightRecords.length > 0 ? weightRecords[weightRecords.length - 1].avg_weight : 0.045; // 45 جرام وزن الكتكوت عمر يوم
        const active_birds = barn.initial_chicks - current_dead;
        const total_biomass = (active_birds * latest_weight) / 1000; // تحويل إلى كجم
        
        // حساب الـ FCR الفعلي والـ PI الإنتاجي القياسي
        const fcr = total_biomass > 0 ? (total_feed_consumed / total_biomass).toFixed(2) : 0;
        
        // معامل الكفاءة الإنتاجية الأوروبي القياسي (EPI / EPEF)
        // EPI = (الحيوية % × الوزن المتوسط بالجم) / (العمر بالأيام × FCR) × 100
        const livability = ((barn.initial_chicks - current_dead) / barn.initial_chicks) * 100;
        const current_age = records.length > 0 ? records[records.length - 1].age : 1;
        const epi = (fcr > 0 && current_age > 0) ? (((livability * (latest_weight)) / (current_age * fcr)) * 100).toFixed(0) : 0;

        res.send({
          total_feed_consumed,
          fcr,
          epi,
          livability: livability.toFixed(2),
          current_age,
          records,
          weightRecords
        });
      });
    });
  });
});

// جلب التنبيهات الفعالة لغرفة التحكم لإدارة الطوارئ
app.get("/api/alerts", (req, res) => {
  db.all("SELECT a.*, b.code as barn_code FROM alerts a JOIN barns b ON a.barn_id = b.id WHERE a.is_read = 0 ORDER BY a.id DESC", [], (err, rows) => {
    res.send(rows);
  });
});

app.listen(3000, () => console.log("Poultry ERP Server running smoothly on port 3000"));


