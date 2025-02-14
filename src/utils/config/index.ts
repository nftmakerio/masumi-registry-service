import * as dotenv from "dotenv";
dotenv.config();

if (process.env.DATABASE_URL == null)
    throw new Error("Undefined DATABASE_URL ENV variables")


const updateCardanoRegistryInterval = Number(process.env.UPDATE_CARDANO_REGISTRY_INTERVAL ?? "300");
if (updateCardanoRegistryInterval < 20)
    throw new Error("Invalid UPDATE_CARDANO_REGISTRY_INTERVAL ENV variables")

const updateCardanoDeregisterInterval = Number(process.env.UPDATE_CARDANO_DEREGISTER_INTERVAL ?? "300");
if (updateCardanoDeregisterInterval < 20)
    throw new Error("Invalid UPDATE_CARDANO_DEREGISTER_INTERVAL ENV variables")

export const CONFIG = {
    PORT: process.env.PORT ?? "3000",
    DATABASE_URL: process.env.DATABASE_URL,
    UPDATE_CARDANO_REGISTRY_INTERVAL: updateCardanoRegistryInterval,
    UPDATE_CARDANO_DEREGISTER_INTERVAL: updateCardanoDeregisterInterval,
    VERSION: "0.1.2"
};