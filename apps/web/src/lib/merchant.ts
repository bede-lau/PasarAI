export type MerchantContext = {
  id: string;
  name: string;
  location: string;
  productId: string;
  productName: string;
};

export const demoMerchant: MerchantContext = {
  id: "m_kak_lina_001",
  name: "Kedai Kak Lina Nasi Lemak",
  location: "SS2, Petaling Jaya",
  productId: "p_nlb_001",
  productName: "Nasi Lemak Biasa"
};

export function getDeploymentMerchant(): MerchantContext | null {
  const merchant = {
    id: process.env.PASARAI_MERCHANT_ID,
    name: process.env.PASARAI_MERCHANT_NAME,
    location: process.env.PASARAI_MERCHANT_LOCATION,
    productId: process.env.PASARAI_PRODUCT_ID,
    productName: process.env.PASARAI_PRODUCT_NAME
  };

  return Object.values(merchant).every(Boolean)
    ? (merchant as MerchantContext)
    : null;
}

export function syntheticPreviewEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.PASARAI_SYNTHETIC_PREVIEW !== "0"
  );
}
