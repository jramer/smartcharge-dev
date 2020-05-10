/**
 * @file Smart charge client for smartcharge.dev project
 * @author Fredrik Lidström
 * @copyright 2019 Fredrik Lidström
 * @license MIT (MIT)
 */

import { gql, InMemoryCache } from "apollo-boost";
import ApolloClient from "apollo-client";
import { mergeURL, log, LogLevel } from "@shared/utils";
import { API_PATH } from "@shared/smartcharge-globals.json";

import fetch from "cross-fetch";

import { ApolloLink } from "apollo-link";
import { WebSocketLink } from "apollo-link-ws";
import { onError } from "apollo-link-error";
import { setContext } from "apollo-link-context";
import { HttpLink } from "apollo-link-http";
import { SubscriptionClient } from "subscriptions-transport-ws";
import { Account } from "@server/gql/account-type";
import {
  UpdateLocationInput,
  UpdatePriceInput,
  Location
} from "@server/gql/location-type";
import {
  Vehicle,
  VehicleToJS,
  UpdateVehicleInput,
  UpdateVehicleDataInput,
  VehicleDebugInput,
  Action
} from "@server/gql/vehicle-type";
import { ServiceProvider } from "@server/gql/service-type";

export class SCClient extends ApolloClient<any> {
  public account?: Account;
  private token?: string;
  private wsClient?: SubscriptionClient;
  constructor(
    server_url: string,
    subscription_url?: string,
    webSocketImpl?: any
  ) {
    const errorLink = onError(({ graphQLErrors, networkError }) => {
      if (graphQLErrors) {
        graphQLErrors.map(({ message, locations, path }) => {
          console.log(
            `[GraphQL error]: Message: ${message}, Location: ${locations}, Path: ${path}`
          );
          if (message === "Unauthorized") {
            this.logout();
          }
        });
      }
      if (networkError) {
        if (
          this.token &&
          (networkError.message === "Authorization failed" ||
            (networkError as any).statusCode === 401)
        ) {
          this.logout();
        }
        console.log(`[Network error]: ${networkError}`);
      }
    });
    const httpLink = ApolloLink.from([
      setContext((_, { headers }) => {
        return {
          headers: this.token
            ? {
                ...headers,
                authorization: `Bearer ${this.token}`
              }
            : headers
        };
      }),
      new HttpLink({
        // You should use an absolute URL here
        uri: mergeURL(server_url, API_PATH),
        fetch: fetch
      })
    ]);

    if (subscription_url) {
      const wsClient = new SubscriptionClient(
        mergeURL(subscription_url, API_PATH),
        {
          connectionParams: () => {
            return this.token ? { Authorization: `Bearer ${this.token}` } : {};
          },
          reconnect: true
        },
        webSocketImpl
      );

      super({
        connectToDevTools: true,
        link: errorLink.concat(new WebSocketLink(wsClient)),
        cache: new InMemoryCache()
      });
      this.wsClient = wsClient;
    } else {
      super({
        connectToDevTools: true,
        link: errorLink.concat(httpLink),
        cache: new InMemoryCache()
      });
    }

    this.defaultOptions = {
      watchQuery: { fetchPolicy: "no-cache", errorPolicy: "none" },
      query: { fetchPolicy: "no-cache", errorPolicy: "none" },
      mutate: { fetchPolicy: "no-cache", errorPolicy: "none" }
    };
  }

  static accountFragment = `id name token`;
  public async loginWithPassword(password: string) {
    this.account = (
      await this.mutate({
        mutation: gql`
          mutation LoginWithPassword($password: String!) {
              loginWithPassword(password: $password) { ${SCClient.accountFragment} }
          }`,
        variables: { password }
      })
    ).data.loginWithPassword;
    this.token = this.account!.token;
    localStorage.setItem("token", this.account!.token);
    if (this.wsClient) {
      this.wsClient.close(false, true);
    }
  }
  public async loginWithAPIToken(token: string) {
    this.token = token;
    this.account = (
      await this.query({
        query: gql`{ account { ${SCClient.accountFragment} } }`
      })
    ).data.account;
  }
  public async loginWithIDToken(idToken: string) {
    this.account = (
      await this.mutate({
        mutation: gql`
      mutation LoginWithIDToken($idToken: String!) {
        loginWithIDToken(idToken: $idToken) { ${SCClient.accountFragment} }
          }`,
        variables: { idToken }
      })
    ).data.loginWithIDToken;
    this.token = this.account!.token;
    localStorage.setItem("token", this.account!.token);
    if (this.wsClient) {
      this.wsClient.close(false, true);
    }
  }

  public get authorized() {
    return Boolean(this.account);
  }
  public async logout() {
    localStorage.removeItem("token");
    this.token = undefined;
    this.account = undefined;
    this.cache.reset();
    if (this.wsClient) {
      this.wsClient.close(false, true);
    }
  }

  static locationFragment = `
  id
  ownerID
  name
  geoLocation {
    latitude
    longitude
  }
  geoFenceRadius
  providerData`;

  public async getLocation(locationUUID: string): Promise<Location> {
    // TODO: should be more flexible, returning just the fields you want into an <any> response instead
    const query = gql`query GetLocation($id: String!) { location(id: $id) { ${SCClient.locationFragment} } }`;
    const result = await this.query({
      query,
      variables: { id: locationUUID }
    });
    return result.data.location;
  }
  public async getLocations(): Promise<Location[]> {
    const query = gql`query GetLocations { locations { ${SCClient.locationFragment} } }`;
    const result = await this.query({ query });
    return result.data.locations as Location[];
  }
  public async updateLocation(input: UpdateLocationInput): Promise<boolean> {
    const mutation = gql`
      mutation UpdateLocation($input: UpdateLocationInput!) {
        updateLocation(input: $input) { ${SCClient.locationFragment}}
      }
    `;
    const result = await this.mutate({
      mutation: mutation,
      variables: { input }
    });
    return result.data.updateLocation;
  }
  public async updatePrice(input: UpdatePriceInput): Promise<boolean> {
    const mutation = gql`
      mutation UpdatePrices($input: UpdatePriceInput!) {
        _updatePrice(input: $input)
      }
    `;
    const result = await this.mutate({
      mutation: mutation,
      variables: { input }
    });
    return result.data._updatePrice;
  }

  static vehicleFragment = `
  id
  name
  maximumLevel
  anxietyLevel
  tripSchedule {
    level
    time
  }
  pausedUntil
  geoLocation {
    latitude
    longitude
  }
  location
  locationSettings {
    location
    directLevel
    goal
  }
  batteryLevel
  odometer
  outsideTemperature
  insideTemperature
  climateControl
  isDriving
  isConnected
  chargePlan {
    chargeType
    chargeStart
    chargeStop
    level
    comment
  }
  chargingTo
  estimatedTimeLeft
  status
  smartStatus
  updated
  serviceID
  providerData`;

  public async getVehicle(vehicleUUID: string): Promise<Vehicle> {
    // TODO: should be more flexible, returning just the fields you want into an <any> response instead
    const query = gql`query GetVehicle($id: String!) { vehicle(id: $id) { ${SCClient.vehicleFragment} } }`;
    const result = await this.query({
      query,
      variables: { id: vehicleUUID }
    });
    return VehicleToJS(result.data.vehicle);
  }
  public async getVehicles(): Promise<Vehicle[]> {
    const query = gql`query GetVehicles { vehicles { ${SCClient.vehicleFragment} } }`;
    const result = await this.query({ query });
    return (result.data.vehicles as Vehicle[]).map(v => VehicleToJS(v));
  }
  public async updateVehicle(input: UpdateVehicleInput): Promise<boolean> {
    const mutation = gql`
      mutation UpdateVehicle($input: UpdateVehicleInput!) {
        updateVehicle(input: $input) { ${SCClient.vehicleFragment}}
      }
    `;
    const result = await this.mutate({
      mutation: mutation,
      variables: { input }
    });
    return result.data.updateVehicle;
  }
  public async updateVehicleData(
    input: UpdateVehicleDataInput
  ): Promise<boolean> {
    // TODO: should be more flexible, returning just the fields you want into an <any> response instead
    const mutation = gql`
      mutation UpdateVehicleData($input: UpdateVehicleDataInput!) {
        _updateVehicleData(input: $input)
      }
    `;
    const result = await this.mutate({
      mutation: mutation,
      variables: { input }
    });
    return result.data._updateVehicleData;
  }
  public async vehicleDebug(input: VehicleDebugInput): Promise<boolean> {
    const mutation = gql`
      mutation VehicleDebug($input: VehicleDebugInput!) {
        _vehicleDebug(input: $input)
      }
    `;
    const result = await this.mutate({
      mutation: mutation,
      variables: { input }
    });
    return result.data._vehicleDebug;
  }

  public async getServiceProviders(
    accept: string[]
  ): Promise<ServiceProvider[]> {
    if (accept.length <= 0) {
      return [];
    }
    const query = gql`
      query ServiceProviders($accept: [String!]!) {
        _serviceProviders(accept: $accept) {
          ownerID
          providerName
          serviceID
          serviceData
        }
      }
    `;
    const result = await this.query({
      query,
      variables: { accept }
    });
    return result.data._serviceProviders;
  }

  public async providerQuery(name: string, input: any): Promise<any> {
    const query = gql`
      query ProviderQuery($name: String!, $input: JSONObject!) {
        providerQuery(name: $name, input: $input)
      }
    `;
    const result = await this.query({
      query,
      variables: { name, input }
    });
    return result.data.providerQuery.result;
  }
  public async providerMutate(name: string, input: any): Promise<any> {
    const mutation = gql`
      mutation ProviderMutate($name: String!, $input: JSONObject!) {
        providerMutate(name: $name, input: $input)
      }
    `;
    const result = await this.mutate({
      mutation,
      variables: { name, input }
    });
    return result.data.providerMutate.result;
  }
  private async actionMutation(
    actionID: number | undefined,
    serviceID: string,
    action: string,
    data?: any
  ) {
    const mutation = gql`
      mutation PerformAction(
        $actionID: Int
        $serviceID: ID!
        $action: String!
        $data: JSONObject
      ) {
        performAction(
          actionID: $actionID
          serviceID: $serviceID
          action: $action
          data: $data
        )
      }
    `;

    const result = await this.mutate({
      mutation,
      variables: { actionID, serviceID, action, data }
    });
    return result.data.performAction;
  }

  public async action(
    serviceID: string,
    action: string,
    data?: any
  ): Promise<Action> {
    return this.actionMutation(undefined, serviceID, action, data);
  }
  public async updateAction(action: Action) {
    return this.actionMutation(
      action.actionID,
      action.serviceID,
      action.action,
      action.data
    );
  }

  public subscribeActions(
    providerName: string | undefined,
    serviceID: string | undefined,
    callback: (action: Action) => any
  ) {
    const query = gql`
      subscription ActionSubscription($providerName: String, $serviceID: ID) {
        actionSubscription(providerName: $providerName, serviceID: $serviceID) {
          actionID
          serviceID
          providerName
          action
          data
        }
      }
    `;
    const result = this.subscribe({
      query,
      variables: { providerName, serviceID }
    });
    result.subscribe({
      next(value: any) {
        const action = value.data.actionSubscription;
        callback(action);
      },
      error(err) {
        log(LogLevel.Error, err);
        throw new Error(err);
      }
    });
  }

  public async chargeCalibration(
    vehicleID: string,
    level: number | undefined,
    duration: number | undefined,
    powerUse: number | undefined
  ) {
    const mutation = gql`
      mutation ChargeCalibration(
        $vehicleID: ID!
        $level: Int
        $duration: Int
        $powerUse: Float
      ) {
        _chargeCalibration(
          vehicleID: $vehicleID
          level: $level
          duration: $duration
          powerUse: $powerUse
        )
      }
    `;

    const result = await this.mutate({
      mutation,
      variables: { vehicleID, level, duration, powerUse }
    });
    return result.data._chargeCalibration;
  }

  public async removeVehicle(id: string, confirm: string): Promise<void> {
    const mutation = gql`
      mutation RemoveVehicle($id: String!, $confirm: String!) {
        removeVehicle(id: $id, confirm: $confirm)
      }
    `;
    await this.mutate({
      mutation: mutation,
      variables: { id, confirm }
    });
  }
}
