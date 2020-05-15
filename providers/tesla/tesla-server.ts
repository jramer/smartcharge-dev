import { IContext, accountFilter } from "@server/gql/api";
import provider, {
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
import { strict as assert } from "assert";

// Check token and refresh through direct database update
export async function maintainToken(
  db: DBInterface,
  oldToken: IRestToken
): Promise<IRestToken> {
  log(LogLevel.Trace, `maintainToken ${JSON.stringify(oldToken)}`);
  try {
    const newToken = await teslaAPI.refreshToken(oldToken);
    if (!newToken) {
      return oldToken;
    }
    assert(oldToken.refresh_token !== undefined);
    if (oldToken.refresh_token) {
      validToken(db, oldToken.refresh_token, newToken);
    }
    return newToken;
  } catch (err) {
    log(LogLevel.Error, err);
    invalidToken(db, oldToken);
    throw new ApolloError("Invalid token", "INVALID_TOKEN");
  }
}

async function validToken(
  db: DBInterface,
  oldRefreshToken: string,
  newToken: IRestToken
) {
  const dblist: DBServiceProvider[] = await db.pg.manyOrNone(
    `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $2) WHERE service_data @> $1 RETURNING *;`,
    [
      { token: { refresh_token: oldRefreshToken } },
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
  log(LogLevel.Trace, `Token ${JSON.stringify(token)} was invalid`);
  assert(token.refresh_token || token.access_token);

  const dblist = await db.pg.manyOrNone(
    `UPDATE service_provider SET service_data = jsonb_strip_nulls(service_data || $2) WHERE service_data @> $1 RETURNING *;`,
    [
      {
        token: {
          refresh_token: token.refresh_token,
          access_token: token.access_token
        }
      },
      { invalid_token: true }
    ]
  );
  log(LogLevel.Trace, dblist);
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
              { token: data.token, updated: Date.now() }
            ]
          );
        }

        const vehicles = [];
        const serviceList = await context.db.getServiceProviders(
          accountFilter(context.accountUUID),
          data.service_uuid,
          [provider.name]
        );

        const controlled = (
          await context.db.getVehicles(accountFilter(context.accountUUID))
        ).reduce((a, v) => {
          const provider_data = v.provider_data as TeslaProviderData;
          if (
            provider_data &&
            provider_data.provider === "tesla" &&
            provider_data.vin
          ) {
            a[provider_data.vin] = v;
          }
          return a;
        }, {} as any);
        const mapped: any = {};

        for (const s of serviceList) {
          if (!s.service_data.invalid_token && s.service_data.token) {
            const token = await maintainToken(context.db, s.service_data.token);
            try {
              const list: any[] = (await teslaAPI.listVehicle(undefined, token))
                .response;

              // Add everything that should be controlled
              for (const l of list) {
                const teslaID = l.id_s;
                const vin = l.vin;
                const vehicle = controlled[vin];
                if (vehicle) {
                  mapped[vin] = mapped[vin] || s.service_uuid;
                  l.service_uuid = mapped[vin];
                  l.vehicle_uuid = vehicle.vehicle_uuid;

                  if (vehicle.service_uuid !== l.service_uuid) {
                    // Wrong service_uuid in database
                    vehicle.service_uuid = l.service_uuid;
                    await context.db.pg.none(
                      `UPDATE vehicle SET service_uuid=$1, provider_data = provider_data - 'invalid_token' WHERE vehicle_uuid=$2;`,
                      [vehicle.service_uuid, vehicle.vehicle_uuid]
                    );
                    log(
                      LogLevel.Info,
                      `Set service_uuid on ${teslaID}:${vehicle.vehicle_uuid} to ${vehicle.service_uuid}`
                    );
                  }
                }
              }
              vehicles.push(...list);
            } catch (err) {
              if (err.code === 401) {
                log(
                  LogLevel.Trace,
                  `${token.access_token} returned error 401 Unauthorized`
                );
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
            config.DEFAULT_MAXIMUM_LEVEL,
            input.service_uuid,
            { provider: "tesla", vin: input.vin } as TeslaProviderData
          );
        }
        await context.db.pg.none(
          `UPDATE service_provider SET service_data = jsonb_merge(service_data, $1)
            WHERE service_uuid=$2;`,
          [{ updated: Date.now() }, input.service_uuid]
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
