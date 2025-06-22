const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const querystring = require('querystring'); // Добавлен модуль для парсинга POST-данных

const PORT = 3000;

// Database connection settings
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'todolist',
  };


// Добавляем функцию для вставки нового элемента
async function addListItem(text) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'INSERT INTO items (text) VALUES (?)';
        const [result] = await connection.execute(query, [text]);
        await connection.end();
        return result.insertId; // Возвращаем ID нового элемента
    } catch (error) {
        console.error('Error adding list item:', error);
        throw error;
    }
}


  async function retrieveListItems() {
    try {
      // Create a connection to the database
      const connection = await mysql.createConnection(dbConfig);
      
      // Query to select all items from the database
      const query = 'SELECT id, text FROM items';
      
      // Execute the query
      const [rows] = await connection.execute(query);
      
      // Close the connection
      await connection.end();
      
      // Return the retrieved items as a JSON array
      return rows;
    } catch (error) {
      console.error('Error retrieving list items:', error);
      throw error; // Re-throw the error
    }
  }

// Stub function for generating HTML rows
async function getHtmlRows() {
    // Example data - replace with actual DB data later
    /*
    const todoItems = [
        { id: 1, text: 'First todo item' },
        { id: 2, text: 'Second todo item' }
    ];*/

    const todoItems = await retrieveListItems();

    // Generate HTML for each item
    return todoItems.map(item => `
        <tr>
            <td>${item.id}</td>
            <td>${item.text}</td>
            <td><button class="delete-btn">×</button></td>
        </tr>
    `).join('');
}

// Модифицируем обработчик запросов
async function handleRequest(req, res) {
    // Обработка POST-запроса для добавления элемента
    if (req.method === 'POST' && req.url === '/add-item') {
        let body = '';
        
        // Собираем данные запроса
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        // Когда все данные получены
        req.on('end', async () => {
            const { text } = querystring.parse(body);
            
            if (!text || text.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Item text cannot be empty');
                return;
            }
            
            try {
                // Добавляем элемент в БД
                const newItemId = await addListItem(text.trim());
                console.log(`New item added with ID: ${newItemId}`);
                
                // Отправляем успешный ответ
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, id: newItemId }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error adding item to database');
            }
        });
    }
    // Обработка GET-запроса главной страницы
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

// Create and start server
const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
