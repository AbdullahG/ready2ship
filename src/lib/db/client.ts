import { MongoClient } from "mongodb";
import { config } from "@/lib/config";

declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

export function getClientPromise(): Promise<MongoClient> {
  const { uri } = config().mongodb;

  // Cached on globalThis so dev hot reloads reuse one connection pool.
  if (!global._mongoClientPromise) {
    global._mongoClient = new MongoClient(uri);
    global._mongoClientPromise = global._mongoClient.connect();
  }
  return global._mongoClientPromise;
}
