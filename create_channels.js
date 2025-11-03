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

// 📦 Endpoint para guardar canal en la base de datos
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
        address: process.env.WEBHOOK_URL, // URL pública de tu webhook
        token: 'optional-token',
      },
    });

    const channelData = response.data;
    console.log('✅ Canal creado exitosamente:');
    console.log(channelData);

    // 🧠 Guardar canal en base de datos
    const safeChannelId = channelData.id.replace(/'/g, "''");
    const safeResourceId = channelData.resourceId?.replace(/'/g, "''") || null;

    const query = `
      INSERT INTO google_channels (id, channel_id, resource_id, expiration)
      VALUES ('current', '${safeChannelId}', '${safeResourceId}', '${channelData.expiration || null}')
      ON CONFLICT (id)
      DO UPDATE SET 
        channel_id = EXCLUDED.channel_id,
        resource_id = EXCLUDED.resource_id,
        expiration = EXCLUDED.expiration;
    `;

    await axios.post(endpoint, { query });
    console.log('💾 Canal guardado en la base de datos');

    console.log('🆔 channel_id:', safeChannelId);
    console.log('🔗 resource_id:', safeResourceId);

  } catch (err) {
    console.error('❌ Error creando o guardando el canal:', err.message);
  }
})();
