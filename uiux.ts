// uiux.ts
export function renderHTML(exhibitions: any[]): string {
  // 1. The Header and CSS
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Paris Museum Tracker</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f0f2f5; margin: 0; padding: 20px; }
            h1 { text-align: center; color: #1a1a1a; }
            .grid { 
                display: grid; 
                grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
                gap: 25px; 
                max-width: 1200px; 
                margin: 0 auto; 
            }
            .card { 
                background: white; 
                border-radius: 12px; 
                overflow: hidden; 
                box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                transition: transform 0.2s;
            }
            .card:hover { transform: translateY(-5px); }
            .card-img { width: 100%; height: 200px; object-fit: cover; }
            .content { padding: 15px; }
            .priority-tag { 
                display: inline-block; 
                padding: 4px 8px; 
                border-radius: 4px; 
                font-size: 0.8rem; 
                font-weight: bold; 
                margin-bottom: 10px;
            }
            .must-see { background: #ff4757; color: white; }
            .nice-to-see { background: #2ed573; color: white; }
        </style>
    </head>
    <body>
        <h1>🎨 Paris Exhibition Tracker</h1>
        <div class="grid">
  `;

  // 2. The Loop (Building the Cards)
  exhibitions.forEach(expo => {
    const priorityClass = expo.priority === 'Must See' ? 'must-see' : 'nice-to-see';
    const dateStr = expo.startDate ? new Date(expo.startDate).toLocaleDateString('fr-FR') : 'TBD';

    html += `
        <div class="card">
            <img class="card-img" src="${expo.cover_url || 'https://via.placeholder.com/400x200'}" alt="${expo.title}">
            <div class="content">
                <div class="priority-tag ${priorityClass}">${expo.priority}</div>
                <h3 style="margin:0 0 10px 0;">${expo.title}</h3>
                <p style="color: #666; margin: 5px 0;"><strong>📍 ${expo.venueName}</strong></p>
                <p style="font-size: 0.9rem; color: #888;">📅 Starts: ${dateStr}</p>
                <a href="${expo.url}" target="_blank" style="display:inline-block; margin-top:10px; color: #3742fa; text-decoration: none; font-weight: bold;">View Details →</a>
            </div>
        </div>
    `;
  });

  // 3. The Footer
  html += `
        </div>
    </body>
    </html>
  `;

  return html;
}
