import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OtpPaymentPage } from "./OtpPaymentPage";

describe("OtpPaymentPage", () => {
  it("renders the platform and the OTP prompt", () => {
    render(
      <OtpPaymentPage
        platform="hyperpure"
        kind="otp"
        prompt="Enter the OTP Hyperpure just sent you"
        onReveal={() => {}}
        onDone={() => {}}
      />,
    );
    expect(screen.getByTestId("handoff-platform")).toHaveTextContent("Hyperpure");
    expect(screen.getByTestId("handoff-prompt")).toHaveTextContent(
      "Enter the OTP Hyperpure just sent you",
    );
  });

  it("shows the amount due for a payment hand-off", () => {
    render(
      <OtpPaymentPage
        platform="amazon"
        kind="payment"
        prompt="Complete payment to place this order"
        amountPaise={123450}
        onReveal={() => {}}
        onDone={() => {}}
      />,
    );
    expect(screen.getByTestId("handoff-amount")).toHaveTextContent("₹1,234.5");
  });

  it("reveals the live webview when the reveal button is tapped", () => {
    const onReveal = vi.fn();
    render(
      <OtpPaymentPage
        platform="hyperpure"
        kind="otp"
        prompt="Enter OTP"
        onReveal={onReveal}
        onDone={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("reveal-button"));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("Done resolves the human-resume hook", async () => {
    let resolved = false;
    let resolveHook!: () => void;
    const humanGate = new Promise<void>((resolve) => {
      resolveHook = resolve;
    });
    void humanGate.then(() => {
      resolved = true;
    });

    render(
      <OtpPaymentPage
        platform="hyperpure"
        kind="otp"
        prompt="Enter OTP"
        onReveal={() => {}}
        onDone={() => resolveHook()}
      />,
    );

    expect(resolved).toBe(false);
    fireEvent.click(screen.getByTestId("done-button"));
    await humanGate;
    expect(resolved).toBe(true);
  });
});
