const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const DB_PATH = path.join(__dirname, 'app.db');

app.use(express.json());
app.use(cors());
app.use(express.static('.'));

// 初始化数据库
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('数据库连接失败:', err);
  else console.log('数据库已连接');
});

// 创建表
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      completed BOOLEAN DEFAULT 0,
      priority TEXT DEFAULT 'normal',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      device_info TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS failed_logins (
      username TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      locked_until DATETIME
    )
  `);
});

// 数据库辅助函数
const dbRun = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
};

// 订阅者（SSE）
const subscribers = new Map(); // userId -> Set of response objects

function notifyUser(userId, event, data) {
  const subs = subscribers.get(userId);
  if (!subs) return;
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try {
      res.write(payload);
    } catch (err) {
      // ignore
    }
  }
}

// 认证中间件
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '缺少认证令牌' });
  }

  console.log('auth token len', token ? token.length : 0, 'start', token ? token.slice(0,10) : '');
  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      console.error('jwt verify error', err);
      return res.status(403).json({ error: '令牌无效或已过期' });
    }
    try {
      // 检查会话是否存在且未过期
      const session = await dbGet('SELECT id, expires_at FROM sessions WHERE token = ?', [token]);
      if (!session) {
        return res.status(401).json({ error: '会话不存在或已登出' });
      }
      const expiresAt = new Date(session.expires_at);
      if (expiresAt.getTime() < Date.now()) {
        // 删除过期会话
        await dbRun('DELETE FROM sessions WHERE id = ?', [session.id]);
        return res.status(403).json({ error: '会话已过期' });
      }

      req.user = user;
      req.token = token;
      next();
    } catch (dbErr) {
      console.error('会话验证错误:', dbErr);
      return res.status(500).json({ error: '服务器错误' });
    }
  });
};

// ============ 用户认证接口 ============

// 注册
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: '缺少必要字段' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少需要6个字符' });
  }

  try {
    const existingUser = await dbGet('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existingUser) {
      return res.status(409).json({ error: '用户名或邮箱已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await dbRun(
      'INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)',
      [userId, username, email, hashedPassword]
    );

    res.status(201).json({
      message: '注册成功',
      user: { id: userId, username, email }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录（含失败限制与锁定）
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '缺少用户名或密码' });
  }

  const LOCK_THRESHOLD = 5; // 最大失败次数
  const LOCK_MINUTES = 15; // 锁定分钟数

  try {
    // 检查是否被锁定
    const failed = await dbGet('SELECT attempts, locked_until FROM failed_logins WHERE username = ?', [username]);
    if (failed && failed.locked_until) {
      const lockedUntil = new Date(failed.locked_until);
      if (lockedUntil.getTime() > Date.now()) {
        return res.status(423).json({ error: `账户锁定，直到 ${lockedUntil.toISOString()}` });
      }
    }

    const user = await dbGet('SELECT id, username, email, password FROM users WHERE username = ? OR email = ?', [username, username]);

    if (!user || !await bcrypt.compare(password, user.password)) {
      // 增加失败计数
      if (failed) {
        const attempts = (failed.attempts || 0) + 1;
        let lockedUntil = null;
        if (attempts >= LOCK_THRESHOLD) {
          lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        }
        await dbRun('UPDATE failed_logins SET attempts = ?, last_attempt = CURRENT_TIMESTAMP, locked_until = ? WHERE username = ?', [attempts, lockedUntil, username]);
      } else {
        const lockedUntil = null;
        await dbRun('INSERT OR REPLACE INTO failed_logins (username, attempts, last_attempt, locked_until) VALUES (?, ?, CURRENT_TIMESTAMP, ?)', [username, 1, lockedUntil]);
      }
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 登录成功：重置失败计数
    await dbRun('DELETE FROM failed_logins WHERE username = ?', [username]);

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const sessionId = uuidv4();

    await dbRun(
      'INSERT INTO sessions (id, user_id, token, device_info, expires_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, user.id, token, req.headers['user-agent'] || 'unknown', expiresAt]
    );

    res.json({
      message: '登录成功',
      token,
      user: { id: user.id, username: user.username, email: user.email }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取当前用户信息
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.user.id]);
    res.json(user);
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 修改密码
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '缺少必要字段' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少需要6个字符' });
  }

  try {
    const user = await dbGet('SELECT password FROM users WHERE id = ?', [req.user.id]);

    if (!user || !await bcrypt.compare(oldPassword, user.password)) {
      return res.status(401).json({ error: '旧密码错误' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await dbRun('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashedPassword, req.user.id]);

    res.json({ message: '密码修改成功' });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登出
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader.split(' ')[1];
    await dbRun('DELETE FROM sessions WHERE token = ?', [token]);
    res.json({ message: '登出成功' });
  } catch (error) {
    console.error('登出错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取会话列表
app.get('/api/auth/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await dbAll(
      'SELECT id, device_info, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(sessions);
  } catch (error) {
    console.error('获取会话列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 强制登出其他设备
app.post('/api/auth/sessions/logout-other', authenticateToken, async (req, res) => {
  try {
    const token = req.token; // 当前token
    await dbRun('DELETE FROM sessions WHERE user_id = ? AND token != ?', [req.user.id, token]);
    res.json({ message: '已强制其他设备登出' });
  } catch (error) {
    console.error('强制登出其他设备错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// SSE 订阅：接收实时更新
app.get('/api/stream', async (req, res) => {
  const token = req.query.token || '';
  if (!token) return res.status(401).end('缺少令牌');

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).end('令牌无效');

    try {
      const session = await dbGet('SELECT id, expires_at FROM sessions WHERE token = ?', [token]);
      if (!session) return res.status(401).end('会话不存在');
      const expiresAt = new Date(session.expires_at);
      if (expiresAt.getTime() < Date.now()) {
        await dbRun('DELETE FROM sessions WHERE id = ?', [session.id]);
        return res.status(403).end('会话已过期');
      }

      // 设置 SSE 头
      res.writeHead(200, {
        'Connection': 'keep-alive',
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      });
      res.write('\n');

      const userId = user.id;
      if (!subscribers.has(userId)) subscribers.set(userId, new Set());
      const set = subscribers.get(userId);
      set.add(res);

      req.on('close', () => {
        set.delete(res);
      });
    } catch (error) {
      console.error('SSE错误:', error);
      res.status(500).end('服务器错误');
    }
  });
});

// ============ TODO接口 ============

// 获取所有TODO
app.get('/api/todos', authenticateToken, async (req, res) => {
  try {
    const todos = await dbAll(
      'SELECT id, text, completed, priority, created_at, updated_at FROM todos WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(todos);
  } catch (error) {
    console.error('获取TODO错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建TODO
app.post('/api/todos', authenticateToken, async (req, res) => {
  const { text, priority } = req.body;

  if (!text) {
    return res.status(400).json({ error: '缺少待办文本' });
  }

  try {
    const todoId = uuidv4();
    await dbRun(
      'INSERT INTO todos (id, user_id, text, priority) VALUES (?, ?, ?, ?)',
      [todoId, req.user.id, text, priority || 'normal']
    );

    const todo = await dbGet('SELECT id, text, completed, priority, created_at, updated_at FROM todos WHERE id = ?', [todoId]);
    res.status(201).json(todo);
    // 推送实时更新
    notifyUser(req.user.id, 'created', todo);
  } catch (error) {
    console.error('创建TODO错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新TODO
app.put('/api/todos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { text, completed, priority } = req.body;

  try {
    const todo = await dbGet('SELECT user_id FROM todos WHERE id = ?', [id]);

    if (!todo) {
      return res.status(404).json({ error: 'TODO不存在' });
    }

    if (todo.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此TODO' });
    }

    const updates = [];
    const params = [];

    if (text !== undefined) {
      updates.push('text = ?');
      params.push(text);
    }
    if (completed !== undefined) {
      updates.push('completed = ?');
      params.push(completed ? 1 : 0);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      params.push(priority);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '没有字段被修改' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await dbRun(
      `UPDATE todos SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    const updatedTodo = await dbGet('SELECT id, text, completed, priority, created_at, updated_at FROM todos WHERE id = ?', [id]);
    res.json(updatedTodo);
    // 推送实时更新
    notifyUser(req.user.id, 'updated', updatedTodo);
  } catch (error) {
    console.error('更新TODO错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除TODO
app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const todo = await dbGet('SELECT user_id FROM todos WHERE id = ?', [id]);

    if (!todo) {
      return res.status(404).json({ error: 'TODO不存在' });
    }

    if (todo.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除此TODO' });
    }

    await dbRun('DELETE FROM todos WHERE id = ?', [id]);
    res.json({ message: '删除成功' });
    // 推送实时更新
    notifyUser(req.user.id, 'deleted', { id });
  } catch (error) {
    console.error('删除TODO错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 清除已完成的TODO
app.delete('/api/todos/batch/completed', authenticateToken, async (req, res) => {
  try {
    await dbRun('DELETE FROM todos WHERE user_id = ? AND completed = 1', [req.user.id]);
    res.json({ message: '清除成功' });
    // 推送当前列表
    const todos = await dbAll('SELECT id, text, completed, priority, created_at, updated_at FROM todos WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    notifyUser(req.user.id, 'list', todos);
  } catch (error) {
    console.error('清除已完成TODO错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`✨ 服务器运行在 http://localhost:${PORT}`);
});
