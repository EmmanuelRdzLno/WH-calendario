import dotenv from 'dotenv';
import { google } from 'googleapis';
import axios from 'axios';

dotenv.config();

// ⚙️ Configurar OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const endpoint = process.env.ENDPOINT_POSTGRES;

(async () => {
  try {
    // 🔑 Generar ID único para el canal
    const uniqueId = 'canal-' + Date.now();

    console.log('🌀 Creando canal de notificaciones...');
    const response = await calendar.events.watch({
      calendarId: 'primary',
      requestBody: {
        id: uniqueId,
        type: 'web_hook',
        address: process.env.URL_NOTIFICACIONES_CALENDAR, // URL pública de tu webhook
        token: 'optional-token',
      },
    });

    const channelData = response.data;
    console.log('✅ Canal creado exitosamente:');
    console.log(channelData);

    const safeId = channelData.id.replace(/'/g, "''");
    const safeResourceId = channelData.resourceId?.replace(/'/g, "''") || null;
    const expiration = channelData.expiration ? `'${channelData.expiration}'` : 'NULL';

    // 🧠 Desactivar canales anteriores y guardar el nuevo canal como activo
    const query = `
      UPDATE google_channels SET active = false;
      INSERT INTO google_channels (id, resource_id, expiration, active, created_at, updated_at)
      VALUES ('${safeId}', '${safeResourceId}', ${expiration}, true, NOW(), NOW());
    `;

    await axios.post(endpoint, { query });
    console.log('💾 Canal guardado en la base de datos como activo');

    console.log('🆔 Canal ID:', safeId);
    console.log('🔗 Resource ID:', safeResourceId);
    console.log('⏰ Expiration:', channelData.expiration || 'N/A');

  } catch (err) {
    console.error('❌ Error creando o guardando el canal:', err.message);
  }
})();
