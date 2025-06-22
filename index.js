const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const querystring = require('querystring');

const PORT = 3000;

// Database connection settings
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'todolist',
};

async function retrieveListItems() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'SELECT id, text FROM items';
        const [rows] = await connection.execute(query);
        await connection.end();
        return rows;
    } catch (error) {
        console.error('Error retrieving list items:', error);
        throw error;
    }
}

async function addListItem(text) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'INSERT INTO items (text) VALUES (?)';
        const [result] = await connection.execute(query, [text]);
        await connection.end();
        return result.insertId;
    } catch (error) {
        console.error('Error adding list item:', error);
        throw error;
    }
}

async function deleteListItem(id) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'DELETE FROM items WHERE id = ?';
        const [result] = await connection.execute(query, [id]);
        await connection.end();
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error deleting list item:', error);
        throw error;
    }
}

async function updateListItem(id, text) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'UPDATE items SET text = ? WHERE id = ?';
        const [result] = await connection.execute(query, [text, id]);
        await connection.end();
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error updating list item:', error);
        throw error;
    }
}

async function getHtmlRows() {
    const todoItems = await retrieveListItems();
    return todoItems.map(item => `
        <tr data-id="${item.id}">
            <td>${item.id}</td>
            <td class="item-text">${item.text}</td>
            <td class="item-actions">
                <button class="edit-btn" onclick="startEdit(${item.id})">Edit</button>
                <button class="delete-btn" onclick="deleteItem(${item.id})">×</button>
            </td>
        </tr>
    `).join('');
}

async function handleRequest(req, res) {
    // Обработка POST запроса для добавления элемента
    if (req.method === 'POST' && req.url === '/add-item') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            const { text } = querystring.parse(body);
            
            if (!text || text.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Item text cannot be empty');
                return;
            }
            
            try {
                const newItemId = await addListItem(text.trim());
                console.log(`New item added with ID: ${newItemId}`);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, id: newItemId }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error adding item to database');
            }
        });
    }
    // Обработка POST запроса для удаления элемента
    else if (req.method === 'POST' && req.url === '/delete-item') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            const { id } = querystring.parse(body);
            
            if (!id || isNaN(id)) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid item ID');
                return;
            }
            
            try {
                const deleted = await deleteListItem(parseInt(id));
                if (deleted) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Item not found' }));
                }
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error deleting item from database');
            }
        });
    }
    // Обработка POST запроса для обновления элемента
    else if (req.method === 'POST' && req.url === '/update-item') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            const { id, text } = querystring.parse(body);
            
            if (!id || isNaN(id) || !text || text.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid data');
                return;
            }
            
            try {
                const updated = await updateListItem(parseInt(id), text.trim());
                if (updated) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Item not found' }));
                }
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error updating item in database');
            }
        });
    }
    // Обработка GET запроса главной страницы
    else if (req.url === '/') {
        try {
            const html = await fs.promises.readFile(
                path.join(__dirname, 'index.html'), 
                'utf8'
            );
            
            const processedHtml = html.replace('{{rows}}', await getHtmlRows());
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(processedHtml);
        } catch (err) {
            console.error(err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading index.html');
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Route not found');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
