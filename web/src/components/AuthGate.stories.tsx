import { useLayoutEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { AuthGate } from "./AuthGate";

type AuthMode = "admin" | "google" | "admin-hidden" | "invalid";
const signedIn = fn();

function AuthSurface({ mode }: { mode: AuthMode }) {
  const original = useRef(window.fetch);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const fetchMock = useRef(fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/config") {
      return new Response(JSON.stringify({
        google: { enabled: modeRef.current === "google" },
        admin: { enabled: modeRef.current !== "admin-hidden" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/api/me") {
      return new Response(modeRef.current === "invalid" ? "unauthorized" : "{}", {
        status: modeRef.current === "invalid" ? 401 : 200,
      });
    }
    throw new Error(`Unexpected AuthGate fetch: ${path}`);
  })).current;
  useLayoutEffect(() => {
    window.fetch = fetchMock;
    return () => {
      if (window.fetch === fetchMock) window.fetch = original.current;
    };
  }, [fetchMock]);
  return <AuthGate onSignedIn={signedIn} />;
}

const meta = {
  title: "Web/Auth/Auth gate",
  component: AuthSurface,
  args: { mode: "admin" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AuthSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdminKey: Story = {
  parameters: {
    docs: { description: { story: "The expected key-only sign-in screen when Google authentication is unavailable." } },
  },
  play: async ({ canvasElement }) => {
    signedIn.mockClear();
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("link", { name: "agora.kite.space" }))
      .resolves.toHaveAttribute("href", "https://agora.kite.space");
    const input = await canvas.findByLabelText("Admin key");
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, "storybook-token{Enter}");
    await expect(signedIn).toHaveBeenCalled();
  },
};

export const GoogleFirst: Story = {
  args: { mode: "google" },
  parameters: {
    docs: { description: { story: "Google is the primary sign-in method; the admin-key form remains available behind “Sign in as admin”." } },
  },
  play: async ({ canvasElement }) => {
    signedIn.mockClear();
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("button", { name: "Continue with Google" })).resolves.toBeVisible();
    expect(canvas.queryByLabelText("Admin key")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Sign in as admin" }));
    await expect(canvas.findByLabelText("Admin key")).resolves.toBeVisible();
  },
};

export const InvalidAdminKey: Story = {
  args: { mode: "invalid" },
  parameters: {
    docs: { description: { story: "Submits a rejected key and finishes with the warning toast visible so the failure treatment can be reviewed." } },
  },
  play: async ({ canvasElement }) => {
    signedIn.mockClear();
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText("Admin key"), "wrong{Enter}");
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByText("That token didn't work")).resolves.toBeVisible();
    await expect(signedIn).not.toHaveBeenCalled();
  },
};

export const AdminLoginHidden: Story = {
  args: { mode: "admin-hidden" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.queryByLabelText("Admin key")).not.toBeInTheDocument();
      expect(canvas.queryByRole("button", { name: "Sign in as admin" })).not.toBeInTheDocument();
    });
    await expect(canvas.findByText(
      "No interactive sign-in method is enabled on this server. Contact its administrator.",
    )).resolves.toBeVisible();
  },
};
