// Todo App JavaScript
class TodoApp {
    constructor() {
        this.todos = [];
        this.currentFilter = 'all';
        this.init();
    }

    init() {
        this.loadTodos();
        this.setupElements();
        this.setupEventListeners();
        this.render();
    }

    setupElements() {
        this.todoInput = document.getElementById('todoInput');
        this.addBtn = document.getElementById('addBtn');
        this.todoList = document.getElementById('todoList');
        this.emptyState = document.getElementById('emptyState');
        this.clearBtn = document.getElementById('clearBtn');
        this.totalCount = document.getElementById('totalCount');
        this.completedCount = document.getElementById('completedCount');
        this.filterBtns = document.querySelectorAll('.filter-btn');
    }

    setupEventListeners() {
        // 添加待办事项
        this.addBtn.addEventListener('click', () => this.addTodo());
        this.todoInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.addTodo();
            }
        });

        // 清除已完成
        this.clearBtn.addEventListener('click', () => this.clearCompleted());

        // 过滤按钮
        this.filterBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.filterBtns.forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentFilter = e.target.dataset.filter;
                this.render();
            });
        });
    }

    addTodo() {
        const text = this.todoInput.value.trim();
        
        if (text === '') {
            alert('请输入待办事项！');
            return;
        }

        const todo = {
            id: Date.now(),
            text: text,
            completed: false,
            createdAt: new Date().toLocaleString('zh-CN')
        };

        this.todos.push(todo);
        this.todoInput.value = '';
        this.todoInput.focus();
        this.saveTodos();
        this.render();
    }

    deleteTodo(id) {
        this.todos = this.todos.filter(todo => todo.id !== id);
        this.saveTodos();
        this.render();
    }

    toggleComplete(id) {
        const todo = this.todos.find(t => t.id === id);
        if (todo) {
            todo.completed = !todo.completed;
            this.saveTodos();
            this.render();
        }
    }

    clearCompleted() {
        const completedCount = this.todos.filter(t => t.completed).length;
        
        if (completedCount === 0) {
            alert('没有已完成的项目！');
            return;
        }

        if (confirm(`确定要清除 ${completedCount} 个已完成的项目吗？`)) {
            this.todos = this.todos.filter(t => !t.completed);
            this.saveTodos();
            this.render();
        }
    }

    getFilteredTodos() {
        switch (this.currentFilter) {
            case 'active':
                return this.todos.filter(t => !t.completed);
            case 'completed':
                return this.todos.filter(t => t.completed);
            default:
                return this.todos;
        }
    }

    updateStats() {
        const total = this.todos.length;
        const completed = this.todos.filter(t => t.completed).length;
        
        this.totalCount.textContent = `总数: ${total}`;
        this.completedCount.textContent = `已完成: ${completed}`;
    }

    render() {
        const filteredTodos = this.getFilteredTodos();
        
        // 更新统计
        this.updateStats();

        // 清空列表
        this.todoList.innerHTML = '';

        // 显示或隐藏空状态
        if (filteredTodos.length === 0) {
            this.emptyState.classList.add('show');
        } else {
            this.emptyState.classList.remove('show');
        }

        // 渲染待办事项
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
                <span class="todo-text">${this.escapeHtml(todo.text)}</span>
                <button class="delete-btn" data-id="${todo.id}">删除</button>
            `;

            // 复选框事件
            const checkbox = li.querySelector('.checkbox');
            checkbox.addEventListener('change', () => {
                this.toggleComplete(todo.id);
            });

            // 删除按钮事件
            const deleteBtn = li.querySelector('.delete-btn');
            deleteBtn.addEventListener('click', () => {
                this.deleteTodo(todo.id);
            });

            this.todoList.appendChild(li);
        });

        // 更新清除按钮状态
        const hasCompleted = this.todos.some(t => t.completed);
        this.clearBtn.disabled = !hasCompleted;
    }

    saveTodos() {
        localStorage.setItem('todos', JSON.stringify(this.todos));
    }

    loadTodos() {
        const saved = localStorage.getItem('todos');
        this.todos = saved ? JSON.parse(saved) : [];
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new TodoApp();
});
