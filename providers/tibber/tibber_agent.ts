/* eslint-disable require-atomic-updates */
/**
 * @file TibberAPI agent for smartcharge.dev project
 * @author Fredrik Lidström
 * @copyright 2019 Fredrik Lidström
 * @license MIT (MIT)
 */

import { strict as assert } from "assert";

import { RestClient } from "@shared/restclient";
import { PROJECT_AGENT } from "@shared/smartcharge-globals";

import { SCClient } from "@shared/sc-client";
import { log, LogLevel } from "@shared/utils";
import { UpdatePriceInput } from "@shared/gql-types";
import {
  AgentJob,
  AbstractAgent,
  IProviderAgent
} from "@providers/provider-agent";
import provider from ".";

const APP_NAME = `TibberAgent`;
const APP_VERSION = `1.0`;

const AGENT_NAME = "tibber";

const TIBBER_API_BASE_URL = "https://api.tibber.com/v1-beta/gql";

export interface TibberProviderData {
  provider: "tibber";
  home: string; // tibber home id
  currency: string; // currency used for price points
  token: string; // token for API authentication
  invalidToken: boolean;
}

interface TibberAgentSubject extends AgentJob {
  providerData: TibberProviderData;
  state: {};
}

interface PricePoint {
  total: number; //
  startsAt: string; //
  level: string; //
  currency: string; //
}

export class TibberAgent extends AbstractAgent {
  public name: string = AGENT_NAME;
  private tibberAPI: RestClient;
  constructor(private scClient: SCClient) {
    super();
    // TODO replace with gql apollo client ?
    this.tibberAPI = new RestClient({
      baseURL: TIBBER_API_BASE_URL,
      agent: `${PROJECT_AGENT} ${APP_NAME}/${APP_VERSION}`,
      timeout: 120000
    });
  }

  public async work(job: TibberAgentSubject): Promise<number> {
    const now = Date.now();
    let interval = 60;
    if (job.providerData.invalidToken) {
      return interval;
    }

    const res = await this.tibberAPI.post(
      "",
      {
        query:
          `{ viewer { home(id: "${
            job.providerData.home
          }") { currentSubscription { priceInfo { ` +
          `   current { currency } ` +
          `   today { total, startsAt, level, currency } ` +
          `   tomorrow { total, startsAt, level }` +
          `} } } } }`
      },
      job.providerData.token
    );
    if (
      res.errors &&
      res.errors.length > 0 &&
      res.errors[0].message.match(/No valid access token/)
    ) {
      await this.scClient.updateLocation({
        id: job.subjectID,
        providerData: { invalidToken: true }
      });
    } else {
      const priceInfo = res.data.viewer.home.currentSubscription.priceInfo;
      if (
        priceInfo.current &&
        priceInfo.current.currency &&
        job.providerData.currency !== priceInfo.current.currency
      ) {
        job.providerData.currency = priceInfo.current.currency;
        await this.scClient.updateLocation({
          id: job.subjectID,
          providerData: { currency: job.providerData.currency }
        });
      }
      const list: PricePoint[] = [].concat(priceInfo.today, priceInfo.tomorrow);
      assert(list.length > 0);
      const update: UpdatePriceInput = { id: job.subjectID, prices: [] };
      for (const p of list) {
        update.prices.push({ startAt: new Date(p.startsAt), price: p.total });
      }

      log(
        LogLevel.Trace,
        `Sending updatePrice for ${AGENT_NAME}.${
          job.subjectID
        } => ${JSON.stringify(update)}`
      );
      await this.scClient.updatePrice(update);
      const ts = Math.trunc(now / 1e3); // epoch seconds
      interval = Math.trunc(ts / 3600 + 1) * 3600 - ts; // Run again next whole hour
    }
    return interval;
  }
}

const agent: IProviderAgent = {
  ...provider,
  agent: (scClient: SCClient) => new TibberAgent(scClient)
};
export default agent;
