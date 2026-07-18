export type * from "./types/generated.js";

export declare const contractVersion: "v1";
export declare const endpointManifest: import("./types/generated.js").EndpointManifest;
export declare const schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export declare function validateContract(schemaId: string, payload: unknown): string[];
export declare function validateEndpointInvocation(invocation: {
  endpoint_id: string;
  headers?: Readonly<Record<string, string>>;
  payload?: unknown;
}): string[];
