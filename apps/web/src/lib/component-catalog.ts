import {
  validateContract,
  type ComponentCatalogResponse
} from "@pasarai/contracts/v1";

import type { DashboardState } from "@/lib/dashboard-types";
import {
  syntheticPreviewEnabled,
  type MerchantContext
} from "@/lib/merchant";

export type ComponentCatalogState = {
  catalog: ComponentCatalogResponse;
  unavailable: boolean;
};

export async function loadComponentCatalog(
  merchant: MerchantContext,
  asOf: string,
  dashboardState: DashboardState
): Promise<ComponentCatalogState> {
  if (syntheticPreviewEnabled()) {
    if (
      dashboardState.status !== "ready"
      || "unavailableReason" in dashboardState.data.costStack
    ) {
      return {
        catalog: { merchant_id: merchant.id, components: [] },
        unavailable: true
      };
    }
    const components = dashboardState.data.costStack.components.map(
      (component) => ({
        component_id: component.id,
        name: component.name
      })
    );
    return {
      catalog: {
        merchant_id: merchant.id,
        components
      },
      unavailable: false
    };
  }

  const apiBaseUrl = process.env.PASARAI_API_BASE_URL;
  const apiBearerToken = process.env.PASARAI_API_BEARER_TOKEN;
  if (!apiBaseUrl || !apiBearerToken) {
    return {
      catalog: { merchant_id: merchant.id, components: [] },
      unavailable: true
    };
  }

  try {
    const url = new URL("/api/v1/catalog/components", apiBaseUrl);
    url.searchParams.set("merchant_id", merchant.id);
    url.searchParams.set("as_of", asOf);
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiBearerToken}`
      }
    });
    if (!response.ok) {
      return {
        catalog: { merchant_id: merchant.id, components: [] },
        unavailable: true
      };
    }

    const payload: unknown = await response.json();
    if (validateContract("component-catalog.response", payload).length > 0) {
      return {
        catalog: { merchant_id: merchant.id, components: [] },
        unavailable: true
      };
    }
    return {
      catalog: payload as ComponentCatalogResponse,
      unavailable: false
    };
  } catch {
    return {
      catalog: { merchant_id: merchant.id, components: [] },
      unavailable: true
    };
  }
}
