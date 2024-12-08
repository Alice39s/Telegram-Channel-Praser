import fs from "fs";
import readline from "readline";

import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { Logger, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import { DeletedMessage } from "telegram/events/DeletedMessage";
import { LogLevel } from "telegram/extensions/Logger";

import * as SQLite from "./utils/sqlite";
import * as Telegram from "./utils/telegram";
import * as Routers from "./utils/routers";

export const logger = new Logger();
logger.setLevel(LogLevel.DEBUG);

const initDatabase = () => {
  logger.info("Initializing database...");
  const dbPath = "messages.db";
  const isNew = !fs.existsSync(dbPath);
  const database = new Database(dbPath);
  if (isNew) {
    database.exec(fs.readFileSync("./database/init.sql", "utf8"));
  } else {
    // Database migration
  }
  logger.info("Database initialized");
  return database;
};
export const database = initDatabase();

const initTelegram = async () => {
  logger.info("Initializing Telegram...");
  const getSession = () => {
    try {
      return fs.readFileSync("./.session", "utf8");
    } catch (err) {
      return "";
    }
  };
  // Save the session
  const saveSession = (session: any) => {
    try {
      fs.writeFileSync("./.session", session);
    } catch (err) {
      logger.error((err as Error).message);
    }
  };
  const apiId = parseInt(Bun.env.API_ID!);
  const apiHash = Bun.env.API_HASH!;
  const stringSession = new StringSession(getSession());

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  client.setLogLevel(LogLevel.INFO);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await client.start({
    phoneNumber: async () =>
      new Promise((resolve) =>
        rl.question("Please enter your number:\n", resolve)
      ),
    password: async () =>
      new Promise((resolve) =>
        rl.question("Please enter your password:\n", resolve)
      ),
    phoneCode: async () =>
      new Promise((resolve) =>
        rl.question("Please enter the code you received:\n", resolve)
      ),
    onError: (e) => logger.error(e.message),
  });
  // Initialize the handlers
  logger.info("Initializing Telegram handlers...");
  client.addEventHandler(Telegram.handleNewMessage, new NewMessage({}));
  client.addEventHandler(Telegram.handleEditedMessage, new EditedMessage({}));
  client.addEventHandler(Telegram.handleDeleteMessage, new DeletedMessage({}));
  // Save the session
  saveSession(client.session.save());
  logger.info("Telegram logged in");
  return client;
};
export const client = await initTelegram();

const checkDatabase = async () => {
  logger.info("Checking database...");
  const savedMessages = SQLite.getMessages() as DataMessages[];
  const lastMessage = await Telegram.getLastMessage();
  const startId =
    savedMessages.length === 0
      ? 0
      : savedMessages[savedMessages.length - 1].message_id;
  const endId = lastMessage.messages[0].id + 1;
  const itemsPerTimes = 500;

  if (startId + 1 < endId) {
    logger.info("Fetching messages...");
    const times = Math.ceil((endId - startId) / itemsPerTimes);
    const messages = [];
    for (let i = 0; i < times; i++) {
      const minId = startId + i * itemsPerTimes;
      const maxId =
        minId + itemsPerTimes > endId ? endId : minId + itemsPerTimes;

      const result = await Telegram.getMessages(minId, maxId);
      messages.push(...result);
      break;
    }
    messages.sort((a, b) => a.message_id - b.message_id);
    for (const message of messages) {
      SQLite.insertMessage(message.message_id, JSON.stringify(message.content));
    }
    logger.info("Fetch messages done");
  } else {
    logger.info("No new messages");
  }
};
await checkDatabase();

// Initialize the HTTP server
const app = new Hono();
// Initialize the middleware
app.use(Routers.loggerHandler);
app.onError(Routers.errorHandler);
// Initialize the routers
for (const router of Routers.routers) {
  app.on(router.method, router.path, router.handler);
}

// Start the HTTP server
logger.info("Starting the server...");
Bun.serve({
  port: Bun.env.PORT!,
  fetch: app.fetch,
});