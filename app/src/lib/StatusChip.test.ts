import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import StatusChip from "./StatusChip.svelte";

describe("StatusChip", () => {
  it("shows the callsign", () => {
    const { getByText } = render(StatusChip, { callsign: "Team3-Mike", online: true });
    expect(getByText(/Team3-Mike/)).toBeTruthy();
  });

  it("shows 'live' when online", () => {
    const { getByText } = render(StatusChip, { callsign: "Mike", online: true });
    expect(getByText(/live/i)).toBeTruthy();
  });

  it("shows 'offline' when not online", () => {
    const { getByText } = render(StatusChip, { callsign: "Mike", online: false });
    expect(getByText(/offline/i)).toBeTruthy();
  });
});
