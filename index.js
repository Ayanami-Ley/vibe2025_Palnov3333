const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram settings
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Database connection settings
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'todolist',
};

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));
app.use(express.static('public'));

// Create users and telegram_subscriptions tables if not exists
async function initDatabase() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        
        // Users table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Telegram subscriptions table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS telegram_subscriptions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                chat_id VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        // Items table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                text VARCHAR(255) NOT NULL,
                user_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notified BOOLEAN DEFAULT FALSE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        await connection.end();
        console.log('Database tables initialized');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Telegram notification functions
async function sendTelegramNotification(chatId, message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        return response.data;
    } catch (error) {
        console.error('Telegram API error:', error.response?.data || error.message);
        throw error;
    }
}

async function sendNewTaskNotifications() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        
        // Get un-notified tasks
        const [tasks] = await connection.execute(`
            SELECT i.id, i.text, u.username, t.chat_id 
            FROM items i
            JOIN users u ON u.id = i.user_id
            JOIN telegram_subscriptions t ON t.user_id = u.id
            WHERE i.notified = FALSE
        `);
        
        for (const task of tasks) {
            try {
                const message = `📝 *New task added!*\n\n` +
                               `👤 *User:* ${task.username}\n` +
                               `✅ *Task:* ${task.text}\n` +
                               `🕒 *Added at:* ${new Date(task.created_at).toLocaleString()}`;
                
                await sendTelegramNotification(task.chat_id, message);
                
                // Mark as notified
                await connection.execute(
                    'UPDATE items SET notified = TRUE WHERE id = ?',
                    [task.id]
                );
                
                console.log(`Notification sent for task ${task.id}`);
            } catch (error) {
                console.error(`Failed to send notification for task ${task.id}:`, error.message);
            }
        }
        
        await connection.end();
    } catch (error) {
        console.error('Error in notification task:', error);
    }
}

// Schedule notification task every 5 minutes
cron.schedule('*/5 * * * *', sendNewTaskNotifications);

// Routes
app.get('/', requireAuth, async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
        const rows = await getHtmlRows(req.session.user.id);
        const processedHtml = html
            .replace('{{rows}}', rows)
            .replace('{{username}}', req.session.user.username);
        
        res.send(processedHtml);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading page');
    }
});

app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).send('Username and password are required');
    }
    
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute(
            'SELECT * FROM users WHERE username = ?', 
            [username]
        );
        await connection.end();
        
        if (rows.length === 0) {
            return res.status(401).send('Invalid username or password');
        }
        
        const user = rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);
        
        if (!passwordMatch) {
            return res.status(401).send('Invalid username or password');
        }
        
        req.session.user = { id: user.id, username: user.username };
        res.redirect('/');
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).send('Server error');
    }
});

app.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'register.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).send('Username and password are required');
    }
    
    if (password.length < 6) {
        return res.status(400).send('Password must be at least 6 characters');
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const connection = await mysql.createConnection(dbConfig);
        
        await connection.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );
        
        await connection.end();
        res.redirect('/login');
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).send('Username already exists');
        }
        console.error('Registration error:', error);
        res.status(500).send('Server error');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('Logout failed');
        }
        res.redirect('/login');
    });
});

// Telegram subscription route
app.post('/subscribe-telegram', requireAuth, async (req, res) => {
    const { chatId } = req.body;
    const userId = req.session.user.id;
    
    if (!chatId) {
        return res.status(400).json({ error: 'Chat ID is required' });
    }
    
    try {
        const connection = await mysql.createConnection(dbConfig);
        
        // Check if already subscribed
        const [existing] = await connection.execute(
            'SELECT * FROM telegram_subscriptions WHERE user_id = ?',
            [userId]
        );
        
        if (existing.length > 0) {
            // Update existing subscription
            await connection.execute(
                'UPDATE telegram_subscriptions SET chat_id = ? WHERE user_id = ?',
                [chatId, userId]
            );
        } else {
            // Create new subscription
            await connection.execute(
                'INSERT INTO telegram_subscriptions (user_id, chat_id) VALUES (?, ?)',
                [userId, chatId]
            );
        }
        
        await connection.end();
        
        res.json({ success: true, message: 'Telegram subscription updated!' });
    } catch (error) {
        console.error('Telegram subscription error:', error);
        res.status(500).json({ error: 'Failed to update Telegram subscription' });
    }
});

// Todo list API routes
app.post('/add-item', requireAuth, async (req, res) => {
    const { text } = req.body;
    const userId = req.session.user.id;
    
    if (!text || text.trim() === '') {
        return res.status(400).json({ error: 'Item text cannot be empty' });
    }
    
    try {
        const newItemId = await addListItem(userId, text.trim());
        res.json({ success: true, id: newItemId });
    } catch (error) {
        console.error('Error adding item:', error);
        res.status(500).json({ error: 'Error adding item to database' });
    }
});

app.post('/delete-item', requireAuth, async (req, res) => {
    const { id } = req.body;
    
    if (!id || isNaN(id)) {
        return res.status(400).json({ error: 'Invalid item ID' });
    }
    
    try {
        const deleted = await deleteListItem(parseInt(id), req.session.user.id);
        if (deleted) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Item not found' });
        }
    } catch (error) {
        console.error('Error deleting item:', error);
        res.status(500).json({ error: 'Error deleting item from database' });
    }
});

app.post('/update-item', requireAuth, async (req, res) => {
    const { id, text } = req.body;
    
    if (!id || isNaN(id) || !text || text.trim() === '') {
        return res.status(400).json({ error: 'Invalid data' });
    }
    
    try {
        const updated = await updateListItem(
            parseInt(id), 
            text.trim(), 
            req.session.user.id
        );
        if (updated) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Item not found' });
        }
    } catch (error) {
        console.error('Error updating item:', error);
        res.status(500).json({ error: 'Error updating item in database' });
    }
});

// Database functions
async function retrieveListItems(userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'SELECT id, text FROM items WHERE user_id = ?';
        const [rows] = await connection.execute(query, [userId]);
        await connection.end();
        return rows;
    } catch (error) {
        console.error('Error retrieving list items:', error);
        throw error;
    }
}

async function addListItem(userId, text) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'INSERT INTO items (text, user_id) VALUES (?, ?)';
        const [result] = await connection.execute(query, [text, userId]);
        await connection.end();
        return result.insertId;
    } catch (error) {
        console.error('Error adding list item:', error);
        throw error;
    }
}

async function deleteListItem(id, userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'DELETE FROM items WHERE id = ? AND user_id = ?';
        const [result] = await connection.execute(query, [id, userId]);
        await connection.end();
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error deleting list item:', error);
        throw error;
    }
}

async function updateListItem(id, text, userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'UPDATE items SET text = ? WHERE id = ? AND user_id = ?';
        const [result] = await connection.execute(query, [text, id, userId]);
        await connection.end();
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error updating list item:', error);
        throw error;
    }
}

async function getHtmlRows(userId) {
    try {
        const todoItems = await retrieveListItems(userId);
        return todoItems.map(item => `
            <tr data-id="${item.id}">
                <td>${item.id}</td>
                <td class="item-text">${item.text}</td>
                <td class="item-actions">
                    <button class="btn edit-btn" onclick="startEdit(${item.id})">Edit</button>
                    <button class="btn delete-btn" onclick="deleteItem(${item.id})">×</button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error generating HTML rows:', error);
        return '';
    }
}

// Initialize database and start server
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Telegram notifications scheduled every 5 minutes`);
    });
});
