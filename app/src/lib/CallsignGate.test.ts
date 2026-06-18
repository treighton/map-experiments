import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import CallsignGate from "./CallsignGate.svelte";

describe("CallsignGate", () => {
  it("calls onsubmit with the entered callsign", async () => {
    const onsubmit = vi.fn();
    const { getByPlaceholderText, getByRole } = render(CallsignGate, { onsubmit });
    const input = getByPlaceholderText(/callsign/i);
    await fireEvent.input(input, { target: { value: "Team3-Mike" } });
    await fireEvent.click(getByRole("button", { name: /join/i }));
    expect(onsubmit).toHaveBeenCalledWith("Team3-Mike");
  });

  it("does not submit an empty callsign", async () => {
    const onsubmit = vi.fn();
    const { getByRole } = render(CallsignGate, { onsubmit });
    await fireEvent.click(getByRole("button", { name: /join/i }));
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("trims whitespace from the callsign", async () => {
    const onsubmit = vi.fn();
    const { getByPlaceholderText, getByRole } = render(CallsignGate, { onsubmit });
    await fireEvent.input(getByPlaceholderText(/callsign/i), {
      target: { value: "  Sue  " },
    });
    await fireEvent.click(getByRole("button", { name: /join/i }));
    expect(onsubmit).toHaveBeenCalledWith("Sue");
  });
});
