import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { Topbar } from "./Topbar";

const rename = fn(() => ({ ...fixtureMe, display_name: "Thomas" }));

const meta = {
  title: "Web/Connected/Topbar",
  component: Topbar,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "PATCH /api/me": rename,
    },
  },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(fixtureMe.display_name || fixtureMe.username)).resolves.toBeVisible();
    expect(canvas.queryByText(/linked · \d+ agents?/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "People" }));
    expect(useUiState.getState().panel).toBe("people");
  },
};

export const Rename: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTitle("Change how your name appears"));
    const dialog = within(await within(document.body).findByRole("dialog", { name: "Change display name" }));
    const input = dialog.getByLabelText("Display name");
    await userEvent.clear(input);
    await userEvent.type(input, "Thomas");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await expect(rename).toHaveBeenCalledWith({ display_name: "Thomas" });
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Change display name" })).not.toBeInTheDocument());
    await expect(within(canvasElement).findByText("Thomas")).resolves.toBeVisible();
  },
  parameters: {
    docs: {
      description: {
        story: "Renames the signed-in user, verifies the PATCH body, and updates the cached display name to “Thomas”.",
      },
    },
  },
};
