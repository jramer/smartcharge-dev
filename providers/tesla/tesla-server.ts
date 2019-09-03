import { IContext } from "@server/gql/api";
import provider, {
  TeslaServiceData,
  TeslaProviderMutates,
  TeslaProviderQueries,
  TeslaProviderData
} from "./index";
import { IRestToken } from "@shared/restclient";
import { ApolloError } from "apollo-server-express";
import { DBInterface } from "@server/db-interface";
import teslaAPI from "./tesla-api";
import { log, LogLevel } from "@shared/utils";
import { IProviderServer } from "@providers/provider-server";
import { TeslaNewListEntry } from "./app/tesla-helper";
import config from "./tesla-config";
import { DBVehicle, DBServiceProvider } from "@server/db-schema";

// Check token and refresh through direct database update
export async function maintainToken(
  db: DBInterface,
  oldToken: IRestToken
): Promise<IRestToken> {
  try {
    const newToken = await teslaAPI.refreshToken(oldToken);
    if (!newToken) {
      return oldToken;
    }
    validToken(db, oldToken, newToken);
    return newToken;
  } catch (err) {
    log(LogLevel.Error, err);
    invalidToken(db, oldToken);
    throw new ApolloError("Invalid token", "INVALID_TOKEN");
  }
}

async function validToken(
  db: DBInterface,
  oldToken: IRestToken,
  newToken: IRestToken
) {
  const dblist: DBServiceProvider[] = await db.pg.manyOrNone(
    `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $2) WHERE service_data @> $1 RETURNING *;`,
    [
      { token: { refresh_token: oldToken.refresh_token } },
      { token: newToken, invalid_token: null }
    ]
  );
  for (const s of dblist) {
    log(
      LogLevel.Info,
      `Updating Tesla API token for service ${s.service_uuid}`
    );
    await db.pg.none(
      `UPDATE vehicle SET provider_data = jsonb_strip_nulls(provider_data || $2) WHERE service_uuid = $1;`,
      [{ invalid_token: null }, s.service_uuid]
    );
  }
}
async function invalidToken(db: DBInterface, token: IRestToken) {
  const dblist = await db.pg.manyOrNone(
    `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $2) WHERE service_data @> $1 RETURNING *;`,
    [
      {
        token: { access_token: token.access_token }
      },
      { invalid_token: true }
    ]
  );
  for (const s of dblist) {
    log(LogLevel.Info, `Invalidating token for service ${s.service_uuid}`);
    await db.pg.none(
      `UPDATE vehicle SET provider_data = jsonb_strip_nulls(provider_data || $2) WHERE service_uuid = $1;`,
      [s.service_uuid, { invalid_token: true }]
    );
  }
}

const server: IProviderServer = {
  ...provider,
  query: async (data: any, context: IContext) => {
    console.debug(data);
    switch (data.query) {
      case TeslaProviderQueries.Vehicles: {
        if (data.token) {
          await context.db.pg.one(
            `INSERT INTO service_provider(account_uuid, provider_name, service_data)
            VALUES ($1,$2,$3) RETURNING *;`,
            [
              context.accountUUID,
              provider.name,
              { token: data.token, map: {} } as TeslaServiceData
            ]
          );
        }

        const vehicles = [];
        const serviceList = (await context.db.getServiceProviders(
          context.accountUUID,
          [provider.name]
        )) as {
          ownerID: string;
          providerName: string;
          serviceID: string;
          serviceData: TeslaServiceData;
        }[];

        const controlled = serviceList.reduce(
          (m, c) => {
            if (c.serviceData.map) {
              m = { ...m, ...c.serviceData.map };
            }
            return m;
          },
          {} as any
        );
        const mapped: any = {};

        for (const s of serviceList) {
          if (!s.serviceData.invalid_token && s.serviceData.token) {
            const token = await maintainToken(context.db, s.serviceData.token);
            try {
              const list: any[] = (await teslaAPI.listVehicle(undefined, token))
                .response;

              // Kill all maps that does not exist or is already mapped
              for (const teslaID of Object.keys(s.serviceData.map)) {
                const found = list.findIndex(f => f.id_s === teslaID) >= 0;
                if (mapped[teslaID] || !found) {
                  delete s.serviceData.map[teslaID];
                  await context.db.pg.none(
                    `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $1)
                    WHERE service_uuid=$2;`,
                    [{ map: { [teslaID]: null } }, s.serviceID]
                  );
                }
              }

              // Add everything that should be controlled
              for (const l of list) {
                const teslaID = l.id_s;
                if (!mapped[teslaID] && controlled[teslaID]) {
                  const vehicleID = controlled[teslaID];
                  mapped[teslaID] = vehicleID;
                  s.serviceData.map[teslaID] = vehicleID;
                  await context.db.pg.none(
                    `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $1)
                      WHERE service_uuid=$2;
                      UPDATE vehicle SET service_uuid=$2 WHERE vehicle_uuid=$3;`,
                    [{ map: { [teslaID]: vehicleID } }, s.serviceID, vehicleID]
                  );
                }

                l.service_uuid = s.serviceID;
                l.controlled = s.serviceData.map[l.id_s] !== undefined;
              }
              vehicles.push(...list);
            } catch (err) {
              if (err.code === 401) {
                await invalidToken(context.db, token);
              }
            }
          }
        }
        return vehicles;
      }
      default:
        throw new Error(`Invalid query ${data.query} sent to tesla-server`);
    }
  },
  mutation: async (data: any, context: IContext) => {
    switch (data.mutation) {
      case TeslaProviderMutates.RefreshToken: {
        return await maintainToken(
          context.db,
          data.token ? data.token : { refresh_token: data.refresh_token }
        );
      }
      case TeslaProviderMutates.NewVehicle: {
        const input = data.input as TeslaNewListEntry;
        let vehicle: DBVehicle | null = await context.db.pg.oneOrNone(
          `SELECT * FROM vehicle WHERE provider_data->>'provider' = 'tesla' AND provider_data->>'tesla_id' = $1;`,
          [input.id]
        );
        if (vehicle) {
          // Move ownership
          await context.db.pg.none(
            `UPDATE vehicle SET account_uuid=$2, service_uuid=$3 WHERE vehicle_uuid = $1;`,
            [vehicle.vehicle_uuid, context.accountUUID, input.service_uuid]
          );
        } else {
          vehicle = await context.db.newVehicle(
            context.accountUUID,
            input.name,
            config.DEFAULT_MINIMUM_LEVEL,
            config.DEFAULT_MAXIMUM_LEVEL,
            input.service_uuid,
            { provider: "tesla", tesla_id: input.id } as TeslaProviderData
          );
        }
        await context.db.pg.none(
          `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $1)
            WHERE service_uuid=$2;`,
          [{ map: { [input.id]: vehicle.vehicle_uuid } }, input.service_uuid]
        );
        return vehicle;
      }
      default:
        throw new Error(
          `Invalid mutation ${data.mutation} sent to tesla-server`
        );
    }
  }
};
export default server;
