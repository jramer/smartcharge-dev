/**
 * @file config loader for smartcharge.dev project
 * @author Fredrik Lidström
 * @copyright 2019 Fredrik Lidström
 * @license MIT (MIT)
 */

import { DEFAULT_PORT } from "./smartcharge-globals.json";

const config = {
  DATABASE_URL: "postgres://scserver:scserverpass@localhost:5432/smartcharge",
  DATABASE_SSL: "false",
  PUBLIC_URL: "",
  SERVER_IP: "0.0.0.0",
  SERVER_PORT: `${DEFAULT_PORT}`,
  SINGLE_USER: "true",
  SINGLE_USER_PASSWORD: "password",
  GOOGLE_CLIENT_ID:
    "745327173701-2qd5fessuo90ntb416epvfgeam91obdo.apps.googleusercontent.com"
};

if (process && process.env) {
  for (const key of Object.keys(config)) {
    if (process.env[key] !== undefined) {
      (config as any)[key] = process.env[key];
    } else if (process.env[`VUE_APP_${key}`] !== undefined) {
      (config as any)[key] = process.env[`VUE_APP_${key}`];
    }
  }
}

export default config;
