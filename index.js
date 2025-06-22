const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;

const app = express();
const PORT = 3000;

// Database connection settings
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'todolist',
};

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));
app.use(express.static('public'));

// Create users table if not exists
async function initDatabase() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await connection.end();
        console.log('Users table initialized');
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

// Routes
app.get('/', requireAuth, async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
        const rows = await getHtmlRows();
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

async function getHtmlRows() {
    try {
        // This will be replaced by actual user context in the route
        return '';
    } catch (error) {
        console.error('Error generating HTML rows:', error);
        return '';
    }
}

// Initialize database and start server
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});
