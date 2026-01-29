// API 配置
const API_BASE_URL = '/api';

// 应用状态
const appState = {
  user: null,
  token: localStorage.getItem('token'),
  todos: [],
  currentFilter: 'all',
  darkMode: localStorage.getItem('darkMode') === 'true',
  syncing: false,
  eventSource: null
};

// ============ 页面切换 ============

function switchToRegister() {
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('registerForm').classList.remove('hidden');
}

function switchToLogin() {
  document.getElementById('registerForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
}

function showAuthPage() {
  document.getElementById('authPage').classList.remove('hidden');
  document.getElementById('appPage').classList.add('hidden');
}

function showAppPage() {
  document.getElementById('authPage').classList.add('hidden');
  document.getElementById('appPage').classList.remove('hidden');
}

// ============ API 调用 ============

async function apiCall(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (appState.token) {
    options.headers['Authorization'] = `Bearer ${appState.token}`;
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
    const data = await response.json();

    if (response.status === 401) {
      handleUnauthorized();
    }

    if (!response.ok) {
      throw new Error(data.error || '请求失败');
    }

    return data;
  } catch (error) {
    console.error('API 错误:', error);
    throw error;
  }
}

// ============ 认证 ============

async function handleLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  if (!username || !password) {
    showNotification('请输入用户名和密码', 'error');
    return;
  }

  try {
    // 先清除旧用户数据
    clearUserState();
    
    const result = await apiCall('/auth/login', 'POST', { username, password });
    appState.token = result.token;
    appState.user = result.user;
    localStorage.setItem('token', result.token);
    
    // 显示页面并更新用户信息
    showAppPage();
    displayUserInfo();
    
    // 加载新用户的 todos
    await loadTodos();
    
    // 订阅实时更新
    subscribeToStream();
    
    showNotification('登录成功', 'success');
    clearLoginForm();
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

async function handleRegister() {
  const username = document.getElementById('registerUsername').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value.trim();

  if (!username || !email || !password) {
    showNotification('请填写所有字段', 'error');
    return;
  }

  if (password.length < 6) {
    showNotification('密码至少需要6个字符', 'error');
    return;
  }

  try {
    await apiCall('/auth/register', 'POST', { username, email, password });
    showNotification('注册成功，请登录', 'success');
    switchToLogin();
    clearRegisterForm();
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

// 清除用户状态（用于登出和切换用户）
function clearUserState() {
  // 关闭 SSE 连接
  if (appState.eventSource) {
    try { appState.eventSource.close(); } catch (e) { }
    appState.eventSource = null;
  }
  
  // 清除状态
  appState.token = null;
  appState.user = null;
  appState.todos = [];
  
  // 清除 UI
  const todoList = document.getElementById('todoList');
  if (todoList) todoList.innerHTML = '';
  const userDisplay = document.getElementById('userDisplay');
  if (userDisplay) userDisplay.textContent = '';
}

async function handleLogout() {
  try {
    await apiCall('/auth/logout', 'POST');
  } catch (error) {
    console.error('登出失败:', error);
  }

  clearUserState();
  localStorage.removeItem('token');
  showAuthPage();
  switchToLogin();
}

function handleUnauthorized() {
  appState.token = null;
  localStorage.removeItem('token');
  showNotification('登录已过期，请重新登录', 'error');
  showAuthPage();
}

// ============ TODO 操作 ============

async function loadTodos() {
  try {
    appState.todos = await apiCall('/todos');
    render();
  } catch (error) {
    showNotification('加载待办事项失败', 'error');
  }
}

async function addTodo() {
  const text = document.getElementById('todoInput').value.trim();

  if (!text) {
    showNotification('请输入待办事项', 'error');
    return;
  }

  try {
    const todo = await apiCall('/todos', 'POST', { text, priority: 'normal' });
    appState.todos.unshift(todo);
    document.getElementById('todoInput').value = '';
    render();
    showNotification('待办事项已添加', 'success');
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

async function deleteTodo(id) {
  try {
    await apiCall(`/todos/${id}`, 'DELETE');
    appState.todos = appState.todos.filter(t => t.id !== id);
    render();
    showNotification('待办事项已删除', 'success');
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

async function toggleComplete(id) {
  const todo = appState.todos.find(t => t.id === id);
  if (!todo) return;

  try {
    const updated = await apiCall(`/todos/${id}`, 'PUT', { completed: !todo.completed });
    const index = appState.todos.findIndex(t => t.id === id);
    appState.todos[index] = updated;
    render();
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

async function clearCompleted() {
  const completedCount = appState.todos.filter(t => t.completed).length;

  if (completedCount === 0) {
    showNotification('没有已完成的项目', 'error');
    return;
  }

  if (confirm(`确定要清除 ${completedCount} 个已完成的项目吗？`)) {
    try {
      await apiCall('/todos/batch/completed', 'DELETE');
      appState.todos = appState.todos.filter(t => !t.completed);
      render();
      showNotification('已清除完成的项目', 'success');
    } catch (error) {
      showNotification(error.message, 'error');
    }
  }
}

async function syncTodos() {
  if (appState.syncing) return;

  appState.syncing = true;
  const syncBtn = document.getElementById('syncBtn');
  syncBtn.disabled = true;
  syncBtn.classList.add('syncing');

  try {
    await loadTodos();
    showNotification('同步成功', 'success');
  } catch (error) {
    showNotification('同步失败: ' + error.message, 'error');
  } finally {
    appState.syncing = false;
    syncBtn.disabled = false;
    syncBtn.classList.remove('syncing');
  }
}

// ============ UI 更新 ============

function getFilteredTodos() {
  switch (appState.currentFilter) {
    case 'active':
      return appState.todos.filter(t => !t.completed);
    case 'completed':
      return appState.todos.filter(t => t.completed);
    default:
      return appState.todos;
  }
}

function updateStats() {
  const total = appState.todos.length;
  const completed = appState.todos.filter(t => t.completed).length;
  const active = total - completed;
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);

  document.getElementById('totalCount').textContent = total;
  document.getElementById('completedCount').textContent = completed;
  document.getElementById('activeCount').textContent = active;
  document.getElementById('progressPercent').textContent = `${percentage}%`;
  document.getElementById('progressFill').style.width = `${percentage}%`;
}

function render() {
  const filteredTodos = getFilteredTodos();
  const todoList = document.getElementById('todoList');
  const emptyState = document.getElementById('emptyState');

  updateStats();

  todoList.innerHTML = '';

  if (filteredTodos.length === 0) {
    emptyState.classList.add('show');
  } else {
    emptyState.classList.remove('show');
  }

  filteredTodos.forEach(todo => {
    const li = document.createElement('li');
    li.className = `todo-item ${todo.completed ? 'completed' : ''}`;

    li.innerHTML = `
      <input 
        type="checkbox" 
        class="checkbox" 
        ${todo.completed ? 'checked' : ''}
        data-id="${todo.id}"
      >
      <span class="todo-text">${escapeHtml(todo.text)}</span>
      <button class="delete-btn" data-id="${todo.id}">
        <span>🗑️</span>
        <span>删除</span>
      </button>
    `;

    const checkbox = li.querySelector('.checkbox');
    checkbox.addEventListener('change', () => toggleComplete(todo.id));

    const deleteBtn = li.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', () => deleteTodo(todo.id));

    todoList.appendChild(li);
  });

  const clearBtn = document.getElementById('clearBtn');
  const hasCompleted = appState.todos.some(t => t.completed);
  clearBtn.disabled = !hasCompleted;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function applyTheme() {
  const html = document.documentElement;
  if (appState.darkMode) {
    html.classList.add('dark-theme');
    document.getElementById('themeToggle').textContent = '☀️';
  } else {
    html.classList.remove('dark-theme');
    document.getElementById('themeToggle').textContent = '🌙';
  }
}

function toggleTheme() {
  appState.darkMode = !appState.darkMode;
  localStorage.setItem('darkMode', String(appState.darkMode));
  applyTheme();
}

function showNotification(message, type = 'info') {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.className = `notification show ${type}`;

  setTimeout(() => {
    notification.classList.remove('show');
  }, 3000);
}

function clearLoginForm() {
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
}

function clearRegisterForm() {
  document.getElementById('registerUsername').value = '';
  document.getElementById('registerEmail').value = '';
  document.getElementById('registerPassword').value = '';
}

async function displayUserInfo() {
  try {
    const user = await apiCall('/auth/me');
    document.getElementById('userDisplay').textContent = `👤 ${user.username}`;
  } catch (error) {
    console.error('获取用户信息失败:', error);
  }
}

// ============ 事件监听 ============

let appInitialized = false;

function initApp() {
  // 防止重复初始化事件监听器
  if (appInitialized) return;
  appInitialized = true;
  
  // 认证事件
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('registerBtn').addEventListener('click', handleRegister);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  // TODO事件
  document.getElementById('addBtn').addEventListener('click', addTodo);
  document.getElementById('todoInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addTodo();
  });

  document.getElementById('clearBtn').addEventListener('click', clearCompleted);
  document.getElementById('syncBtn').addEventListener('click', syncTodos);

  // 主题切换
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // 过滤按钮
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      appState.currentFilter = e.currentTarget.dataset.filter;
      render();
    });
  });
}

// ============ 初始化 ============

async function checkAuth() {
  // 初始化事件监听器（只执行一次）
  initApp();
  applyTheme();
  
  if (appState.token) {
    try {
      // 先清除可能存在的旧状态
      appState.todos = [];
      
      const user = await apiCall('/auth/me');
      appState.user = user;
      showAppPage();
      displayUserInfo();
      
      // 加载当前用户的 todos
      await loadTodos();
      
      // 订阅实时更新
      subscribeToStream();
    } catch (error) {
      clearUserState();
      localStorage.removeItem('token');
      showAuthPage();
    }
  } else {
    showAuthPage();
  }
}

// ============ 实时更新 (SSE) ============
function subscribeToStream() {
  if (!appState.token) return;
  try {
    if (appState.eventSource) {
      appState.eventSource.close();
      appState.eventSource = null;
    }

    const url = `${API_BASE_URL}/stream?token=${encodeURIComponent(appState.token)}`;
    const es = new EventSource(url);

    es.addEventListener('list', (e) => {
      try {
        appState.todos = JSON.parse(e.data);
        render();
      } catch (err) { console.error('解析list失败', err); }
    });

    es.addEventListener('created', (e) => {
      try {
        const todo = JSON.parse(e.data);
        if (!appState.todos.find(t => t.id === todo.id)) {
          appState.todos.unshift(todo);
          render();
          showNotification('有新的待办已添加', 'info');
        }
      } catch (err) { console.error('解析created失败', err); }
    });

    es.addEventListener('updated', (e) => {
      try {
        const updated = JSON.parse(e.data);
        const idx = appState.todos.findIndex(t => t.id === updated.id);
        if (idx >= 0) appState.todos[idx] = updated;
        else appState.todos.unshift(updated);
        render();
      } catch (err) { console.error('解析updated失败', err); }
    });

    es.addEventListener('deleted', (e) => {
      try {
        const payload = JSON.parse(e.data);
        appState.todos = appState.todos.filter(t => t.id !== payload.id);
        render();
      } catch (err) { console.error('解析deleted失败', err); }
    });

    es.addEventListener('error', (e) => {
      console.error('SSE连接错误', e);
    });

    appState.eventSource = es;
  } catch (err) {
    console.error('订阅失败', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});
