"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent
} from "react";
import { Check, Menu, Plus, X } from "lucide-react";

import type { DashboardProductOption } from "@/lib/demo-dashboard-products";

type DashboardProductPickerProps = {
  products: readonly DashboardProductOption[];
  selectedProductId: string;
  labels: {
    addRecipe: string;
    cancelRecipe: string;
    close: string;
    connected: string;
    createRecipe: string;
    menu: string;
    recipeName: string;
    selected: string;
    title: string;
  };
  onAddRecipe: (productName: string) => void;
  onSelect: (productId: string) => void;
};

export function DashboardProductPicker({
  products,
  selectedProductId,
  labels,
  onAddRecipe,
  onSelect
}: DashboardProductPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isAddingRecipe, setIsAddingRecipe] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const recipeNameRef = useRef<HTMLInputElement>(null);

  function closePicker() {
    setIsOpen(false);
    setIsAddingRecipe(false);
    setRecipeName("");
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!isOpen) return;

    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isAddingRecipe) {
      recipeNameRef.current?.focus();
    }
  }, [isAddingRecipe]);

  function submitRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const productName = recipeName.trim();
    if (!productName) return;

    onAddRecipe(productName);
    closePicker();
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="product-menu-trigger"
        type="button"
        aria-label={labels.menu}
        title={labels.menu}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
      >
        <Menu aria-hidden="true" />
      </button>
      {isOpen ? (
        <>
          <section
            className="product-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-picker-title"
          >
            <header>
              <div>
                <p className="eyebrow">{labels.menu}</p>
                <h2 id="product-picker-title">{labels.title}</h2>
              </div>
              <button
                ref={closeRef}
                className="product-picker-close"
                type="button"
                aria-label={labels.close}
                title={labels.close}
                onClick={closePicker}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <ul className="product-picker-list">
              {products.map((product) => {
                const isSelected =
                  product.productId === selectedProductId;
                return (
                  <li key={product.productId}>
                    <button
                      type="button"
                      data-product-id={product.productId}
                      aria-label={[
                        product.productName,
                        product.mode === "connected"
                          ? labels.connected
                          : null,
                        isSelected ? labels.selected : null
                      ].filter(Boolean).join(", ")}
                      aria-pressed={isSelected}
                      onClick={() => {
                        onSelect(product.productId);
                        closePicker();
                      }}
                    >
                      <span className="product-picker-name">
                        <strong>{product.productName}</strong>
                        {product.mode === "connected" ? (
                          <small className="product-mode product-mode--connected">
                            {labels.connected}
                          </small>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <span className="product-picker-selected">
                          <Check aria-hidden="true" />
                          {labels.selected}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            <footer className="product-picker-footer">
              {isAddingRecipe ? (
                <form
                  className="product-recipe-form"
                  onSubmit={submitRecipe}
                >
                  <label>
                    <span>{labels.recipeName}</span>
                    <input
                      ref={recipeNameRef}
                      value={recipeName}
                      maxLength={60}
                      onChange={(event) =>
                        setRecipeName(event.target.value)
                      }
                    />
                  </label>
                  <div>
                    <button
                      className="product-recipe-cancel"
                      type="button"
                      aria-label={labels.cancelRecipe}
                      title={labels.cancelRecipe}
                      onClick={() => {
                        setIsAddingRecipe(false);
                        setRecipeName("");
                      }}
                    >
                      <X aria-hidden="true" />
                    </button>
                    <button
                      className="product-recipe-submit"
                      type="submit"
                      disabled={!recipeName.trim()}
                    >
                      <Plus aria-hidden="true" />
                      {labels.createRecipe}
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  className="product-add-recipe"
                  type="button"
                  onClick={() => setIsAddingRecipe(true)}
                >
                  <Plus aria-hidden="true" />
                  {labels.addRecipe}
                </button>
              )}
            </footer>
          </section>
          <button
            className="product-picker-backdrop"
            type="button"
            aria-label={labels.close}
            onClick={closePicker}
          />
        </>
      ) : null}
    </>
  );
}
