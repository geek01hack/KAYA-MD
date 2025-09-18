/**
 * index.js — KAYA-MD (version adaptée Render + QR web)
 *
 * Instructions rapides :
 * 1) npm install @whiskeysockets/baileys qrcode express pino
 * 2) Déployer sur Render (Web Service) avec start: "node index.js"
 * 3) Ouvre l'URL fournie par Render et scanne le QR affiché.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const baileys = require('@whiskeysockets/baileys');
// destructuring (selon la version de baileys)
const {
  default: makeWASocket,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeInMemoryStore
} = baileys;

const PORT = process.env.PORT || 3000;
const AUTH_FILE = process.env.AUTH_FILE_PATH || './auth_info_multi.json'; // fichier d'auth
const logger = pino({ level: 'info' });

/* ------------------------------------------------------
   Express (page QR)
   ------------------------------------------------------ */
const app = express();
let latestQRCodeDataUrl = null;
let qrLastUpdated = null;
let connectionStatus = 'starting';

/* simple page pour montrer le QR et un état */
app.get('/', (req, res) => {
  if (!latestQRCodeDataUrl) {
    return res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="5">
          <title>KAYA-MD — QR</title>
        </head>
        <body style="font-family: Arial, sans-serif; text-align:center; padding:40px">
          <h1>KAYA-MD</h1>
          <h2>Status: ${connectionStatus}</h2>
          <p>En attente du QR… cette page se rafraîchit toutes les 5s.</p>
          <p>Si rien n'apparaît, regarde les logs (Render / console) pour voir les erreurs.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head>
        <title>KAYA-MD — QR</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: Arial, sans-serif; text-align:center; padding:20px">
        <h1>KAYA-MD</h1>
        <h3>Status: ${connectionStatus}</h3>
        <p>Dernière génération: ${qrLastUpdated}</p>
        <img src="${latestQRCodeDataUrl}" alt="WhatsApp QR Code" style="max-width:90%;height:auto"/>
        <p style="margin-top:12px">Scanne ce QR avec WhatsApp sur ton téléphone (Menu > Appareils liés > Scanner).</p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: connectionStatus, qrLastUpdated });
});

/* ------------------------------------------------------
   Baileys + Auth
   ------------------------------------------------------ */
const { state, saveState } = useSingleFileAuthState(AUTH_FILE);

// in-memory message store (optionnel mais utile)
let store;
try {
  store = makeInMemoryStore ? makeInMemoryStore({ logger: pino().child({ level: 'silent' }) }) : null;
} catch (e) {
  store = null;
}

async function startSock() {
  try {
    connectionStatus = 'fetching-bailes-version';
    // fetch version (facultatif)
    let version = [2, 2204, 13];
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched && Array.isArray(fetched.version)) version = fetched.version;
      logger.info('Baileys version fetched', { version });
    } catch (err) {
      logger.warn('Could not fetch latest baileys version, using fallback.', err);
    }

    connectionStatus = 'starting-socket';
    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      version
    });

    // bind store if available
    if (store && store.bind) store.bind(sock.ev);

    // sauvegarder automatiquement les credentials quand elles changent
    sock.ev.on('creds.update', saveState);

    // connection update (qr, open, close)
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          // convertit le QR string en DataURL et le stocke pour Express
          try {
            latestQRCodeDataUrl = await QRCode.toDataURL(qr);
            qrLastUpdated = new Date().toISOString();
            logger.info('QR généré et exposé via HTTP /');
            connectionStatus = 'qr-generated';
          } catch (qerr) {
            logger.error('Erreur génération QR DataURL:', qerr);
          }
        }

        if (connection) {
          connectionStatus = connection;
          logger.info('connection.update', { connection });

          if (connection === 'open') {
            logger.info('Connection ouverte — authentification réussie');
            // le QR n'est plus nécessaire
            latestQRCodeDataUrl = null;
            qrLastUpdated = new Date().toISOString();
          }
        }

        if (lastDisconnect && lastDisconnect.error) {
          const err = lastDisconnect.error;
          logger.warn('lastDisconnect:', err && err.output ? err.output.payload : err);

          const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
          // Si on a été déconnecté pour cause d'auth (bad session), on supprime auth file pour forcer re-login
          if (code === DisconnectReason.badSession || code === DisconnectReason.loggedOut) {
            logger.warn('Session invalide. Suppression du fichier d\'auth et redémarrage pour re-login.');
            try {
              fs.unlinkSync(AUTH_FILE);
            } catch (e) {
              logger.error('Impossible de supprimer le fichier auth:', e);
            }
            // relancer: on attend 2s puis restart
            setTimeout(() => startSock(), 2000);
          } else if (code === DisconnectReason.restartRequired || code === DisconnectReason.connectionClosed) {
            logger.info('Redémarrage du socket...');
            setTimeout(() => startSock(), 2000);
          } else {
            logger.info('Tentative de reconnexion dans 5s...');
            setTimeout(() => startSock(), 5000);
          }
        }
      } catch (e) {
        logger.error('Erreur dans connection.update handler:', e);
      }
    });

    // exemple minimal de gestion des messages (tu peux remplacer par ton propre handler)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages || [];
        for (const msg of messages) {
          // ignorer les messages système et messages non textuels si besoin
          if (!msg.message) continue;
          const from = msg.key.remoteJid;
          const isGroup = from && from.endsWith('@g.us');
          // log minimal
          logger.info('Message reçu', { from, key: msg.key, content: Object.keys(msg.message)[0] });
          // Exemple: répondre "OK" si message text
          // if (msg.message.conversation) {
          //   await sock.sendMessage(from, { text: 'OK' }, { quoted: msg });
          // }
        }
      } catch (e) {
        logger.error('Erreur messages.upsert:', e);
      }
    });

    return sock;
  } catch (err) {
    logger.error('Erreur startSock:', err);
    // reessayer dans quelques secondes
    setTimeout(() => startSock(), 5000);
  }
}

/* start everything */
(async () => {
  // start HTTP server
  app.listen(PORT, () => {
    logger.info(`HTTP server pour QR en écoute sur le port ${PORT}`);
  });

  // demarrer Baileys
  await startSock();
})();
