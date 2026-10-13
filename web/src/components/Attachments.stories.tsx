import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { Attachments } from "./Attachments";
import { ImageLightbox as ImageLightboxComponent } from "./ImageLightbox";
import { message } from "../stories/fixtures/data";

const meta = {
  title: "Web/Atoms/Attachments",
  component: Attachments,
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Files: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "requirements", filename: "storybook-requirements.pdf", mime: "application/pdf", size: 428_032 },
        { id: "archive", filename: "component-fixtures.zip", mime: "application/zip", size: 2_842_113 },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filename = await canvas.findByText("storybook-requirements.pdf");
    expect(filename).toBeVisible();
    await expect(canvas.findByText("418.0 KB")).resolves.toBeVisible();
    expect(filename.closest(".ago-file-meta")).not.toBeNull();
    const card = filename.closest(".ago-att-file");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ago-file-icon")).not.toBeNull();
  },
};

export const Video: Story = {
  args: {
    message: {
      ...message,
      attachments: [{ id: "demo-video", filename: "launch-demo.mp4", mime: "video/mp4", size: 24_000_000 }],
    },
  },
  play: async ({ canvasElement }) => {
    const video = canvasElement.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("preload", "metadata");
  },
};

export const VideoFallback: Story = {
  args: {
    message: {
      ...message,
      attachments: [{ id: "missing-video", filename: "missing-demo.mp4", mime: "video/mp4", size: 24_000_000 }],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Exercise the browser error event deterministically, without depending on
    // a missing URL's network timeout under parallel browser-test load.
    const video = canvasElement.querySelector("video");
    if (video) fireEvent.error(video);
    await waitFor(() => expect(canvas.getByText("missing-demo.mp4")).toBeVisible());
    expect(canvasElement.querySelector("video")).toBeNull();
  },
};

export const ImageLightbox: Story = {
  args: {
    message: {
      ...message,
      attachments: [{
        id: "storybook-preview.svg",
        filename: "responsive-layout-preview.svg",
        mime: "image/svg+xml",
        size: 1_024,
      }],
    },
  },
  parameters: {
    docs: { description: { story: "Clicking an inline image opens the full-screen preview. Escape and backdrop clicks close it; this story finishes with the preview open for inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {
      name: "Preview responsive-layout-preview.svg",
    }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", {
      name: "Image preview: responsive-layout-preview.svg",
    });
    await expect(dialog).toBeVisible();
    expect(within(dialog).queryByText("responsive-layout-preview.svg")).toBeNull();
    expect(within(dialog).getByAltText("responsive-layout-preview.svg")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
    const controls = within(dialog);
    await userEvent.click(controls.getByRole("button", { name: "Zoom in" }));
    expect(controls.getByRole("button", { name: "Zoom level 125%; reset zoom" })).toBeVisible();
    await userEvent.keyboard("+");
    expect(controls.getByRole("button", { name: "Zoom level 156%; reset zoom" })).toBeVisible();
    await userEvent.keyboard("-");
    expect(controls.getByRole("button", { name: "Zoom level 125%; reset zoom" })).toBeVisible();
    await userEvent.keyboard("0");
    expect(controls.getByRole("button", { name: "Zoom level 100%; reset zoom" })).toBeVisible();
    await userEvent.dblClick(controls.getByAltText("responsive-layout-preview.svg"));
    expect(controls.getByRole("button", { name: "Zoom level 200%; reset zoom" })).toBeVisible();
    await userEvent.keyboard("{ArrowRight}");
    expect(dialog).toBeVisible();
    await userEvent.click(controls.getByRole("button", { name: "Zoom level 200%; reset zoom" }));
    await expect(controls.getByRole("button", { name: "Zoom level 100%; reset zoom" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", {
      name: "Preview responsive-layout-preview.svg",
    }));
    const reopened = await page.findByRole("dialog", {
      name: "Image preview: responsive-layout-preview.svg",
    });
    await expect(reopened).toBeVisible();
    fireEvent.click(reopened, { clientX: 4, clientY: 4 });
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  },
};

export const PhoneImageZoom: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "phone-first.svg", filename: "phone-first.svg", mime: "image/svg+xml", size: 1_024 },
        { id: "phone-second.svg", filename: "phone-second.svg", mime: "image/svg+xml", size: 1_024 },
      ],
    },
  },
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: { docs: { description: { story: "Phone viewport with the image preview open and zoomed for inspection." } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Preview phone-first.svg" }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: phone-first.svg" });
    const image = within(dialog).getByAltText("phone-first.svg");
    const toolbar = within(dialog).getByRole("group", { name: "Image zoom controls" });
    expect(getComputedStyle(dialog).touchAction).toBe("none");
    const counter = within(dialog).getByText("Image 1 of 2");
    const toolbarRect = toolbar.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const counterRect = counter.getBoundingClientRect();
    expect(toolbarRect.top).toBeGreaterThanOrEqual(imageRect.bottom);
    expect(toolbarRect.bottom).toBeLessThanOrEqual(counterRect.top);
    const closeRect = within(dialog).getByRole("button", { name: "Close image preview" }).getBoundingClientRect();
    expect(closeRect.bottom).toBeLessThanOrEqual(imageRect.top);
    const beforeZoom = image.style.transform;
    await userEvent.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    await within(dialog).findByRole("button", { name: "Zoom level 125%; reset zoom" });
    expect(image.style.transform).not.toBe(beforeZoom);
  },
};

export const ShortViewportLightbox: Story = {
  args: ImageLightbox.args,
  globals: { viewport: { value: "shortDesktop600", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Preview responsive-layout-preview.svg" }));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Image preview: responsive-layout-preview.svg" });
    const image = within(dialog).getByAltText("responsive-layout-preview.svg");
    await waitFor(() => expect((image as HTMLImageElement).naturalWidth).toBeGreaterThan(0));
    const rect = image.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(600);
    const stage = image.parentElement as HTMLDivElement;
    const stageRect = stage.getBoundingClientRect();
    const toolbar = within(dialog).getByRole("group", { name: "Image zoom controls" });
    for (let step = 0; step < 3; step += 1) {
      const pinchWheel = new WheelEvent("wheel", {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -77,
        clientX: stageRect.left + stageRect.width / 2, clientY: stageRect.top + stageRect.height / 2,
      });
      stage.dispatchEvent(pinchWheel);
      expect(pinchWheel.defaultPrevented).toBe(true);
    }
    await within(dialog).findByRole("button", { name: "Zoom level 400%; reset zoom" });
    expect(image.getBoundingClientRect().width).toBeGreaterThan(stage.getBoundingClientRect().width);
    expect(toolbar).toBeVisible();
    await userEvent.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
    await within(dialog).findByRole("button", { name: "Zoom level 500%; reset zoom" });
  },
};

export const ShortViewportZoomBounds: Story = {
  args: ImageLightbox.args,
  globals: { viewport: { value: "shortDesktop600", isRotated: false } },
  render: () => <ImageLightboxComponent
    url="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'%3E%3Crect width='800' height='1200' fill='%23456789'/%3E%3C/svg%3E"
    filename="short-portrait.svg" onClose={() => {}}
  />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: short-portrait.svg" });
    const image = within(dialog).getByAltText("short-portrait.svg") as HTMLImageElement;
    await waitFor(() => expect(image.naturalWidth).toBe(800));
    const stage = image.parentElement as HTMLDivElement;
    const stageRect = stage.getBoundingClientRect();
    const centerX = stageRect.left + stageRect.width / 2;
    const centerY = stageRect.top + stageRect.height / 2;
    let previousTop = image.getBoundingClientRect().top;
    for (let step = 1; step <= 8; step += 1) {
      stage.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10,
        clientX: centerX, clientY: centerY,
      }));
      const percent = Math.round(Math.exp(step * 0.06) * 100);
      await within(dialog).findByRole("button", { name: `Zoom level ${percent}%; reset zoom` });
      const rect = image.getBoundingClientRect();
      expect(Math.abs(rect.top - previousTop)).toBeLessThan(20);
      const viewportHeight = window.innerHeight;
      if (rect.height <= viewportHeight) {
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(viewportHeight + 0.5);
      } else {
        expect(rect.top).toBeLessThanOrEqual(0.5);
        expect(rect.bottom).toBeGreaterThanOrEqual(viewportHeight - 0.5);
      }
      previousTop = rect.top;
    }
  },
};

export const ShortViewportPerAxisPan: Story = {
  args: ImageLightbox.args,
  globals: { viewport: { value: "shortDesktop600", isRotated: false } },
  render: () => <ImageLightboxComponent
    url="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='500'%3E%3Crect width='1600' height='500' fill='%23456789'/%3E%3C/svg%3E"
    filename="wide-only.svg" onClose={() => {}}
  />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: wide-only.svg" });
    const image = within(dialog).getByAltText("wide-only.svg") as HTMLImageElement;
    await waitFor(() => expect(image.naturalWidth).toBe(1600));
    const toolbar = within(dialog).getByRole("group", { name: "Image zoom controls" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
    await within(toolbar).findByRole("button", { name: "Zoom level 125%; reset zoom" });
    const rect = image.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(window.innerWidth);
    expect(rect.height).toBeLessThan(window.innerHeight);

    const beforeVertical = image.style.transform;
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(image.style.transform).toBe(beforeVertical);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(image.style.transform).not.toBe(beforeVertical);
  },
};

export const ImageZoomPanning: Story = {
  args: ImageLightbox.args,
  render: () => <ImageLightboxComponent
    url="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'%3E%3Crect width='800' height='1200' fill='%23456789'/%3E%3C/svg%3E"
    filename="pan-test.svg" onClose={() => { document.body.dataset.imageZoomClosed = "true"; }}
  />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: pan-test.svg" });
    const image = within(dialog).getByAltText("pan-test.svg") as HTMLImageElement;
    await waitFor(() => expect(image.naturalWidth).toBe(800));
    const stage = image.parentElement as HTMLDivElement;
    const initialStage = stage.getBoundingClientRect();
    const centerX = initialStage.left + initialStage.width / 2;
    const centerY = initialStage.top + initialStage.height / 2;
    const plainWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: centerX, clientY: centerY });
    stage.dispatchEvent(plainWheel);
    expect(plainWheel.defaultPrevented).toBe(false);
    await within(dialog).findByRole("button", { name: "Zoom level 100%; reset zoom" });
    for (let i = 0; i < 20; i += 1) {
      const slowPinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1, clientX: centerX, clientY: centerY });
      stage.dispatchEvent(slowPinch);
      expect(slowPinch.defaultPrevented).toBe(true);
    }
    await within(dialog).findByRole("button", { name: /Zoom level 1\d\d%; reset zoom/ });
    await userEvent.keyboard("0");
    const lineWheel = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, ctrlKey: true, deltaMode: 1, deltaY: -3, clientX: centerX, clientY: centerY,
    });
    stage.dispatchEvent(lineWheel);
    expect(lineWheel.defaultPrevented).toBe(true);
    await within(dialog).findByRole("button", { name: "Zoom level 133%; reset zoom" });
    await userEvent.keyboard("0");
    const pageWheel = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, ctrlKey: true, deltaMode: 2, deltaY: -1, clientX: centerX, clientY: centerY,
    });
    stage.dispatchEvent(pageWheel);
    expect(pageWheel.defaultPrevented).toBe(true);
    await within(dialog).findByRole("button", { name: "Zoom level 165%; reset zoom" });
    await userEvent.keyboard("0");
    const pinchWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: centerX, clientY: centerY });
    stage.dispatchEvent(pinchWheel);
    expect(pinchWheel.defaultPrevented).toBe(true);
    await within(dialog).findByRole("button", { name: "Zoom level 165%; reset zoom" });
    await userEvent.keyboard("0");
    const backdropWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 4, clientY: 4 });
    dialog.dispatchEvent(backdropWheel);
    expect(backdropWheel.defaultPrevented).toBe(true);
    await within(dialog).findByRole("button", { name: "Zoom level 165%; reset zoom" });
    await userEvent.keyboard("0");
    await userEvent.dblClick(image);
    expect(within(dialog).getByRole("button", { name: "Zoom level 200%; reset zoom" })).toBeVisible();
    await userEvent.keyboard("+");
    await userEvent.keyboard("+");
    await userEvent.keyboard("+");
    await within(dialog).findByRole("button", { name: "Zoom level 391%; reset zoom" });
    const beforePan = image.style.transform;
    const currentY = Number.parseFloat(beforePan.match(/translate\(0px, ([\d.-]+)px\)/)?.[1] ?? "0");
    await userEvent.keyboard(currentY >= 0 ? "{ArrowDown}" : "{ArrowUp}");
    expect(image.style.transform).not.toBe(beforePan);
    let edgeY = Number.parseFloat(image.style.transform.match(/translate\(0px, ([\d.-]+)px\)/)?.[1] ?? "0");
    const edgeKey = edgeY >= 0 ? "{ArrowUp}" : "{ArrowDown}";
    for (let step = 0; step < 24; step += 1) await userEvent.keyboard(edgeKey);
    const edgeTransform = image.style.transform;
    await userEvent.keyboard(edgeKey);
    expect(image.style.transform).toBe(edgeTransform);
    edgeY = Number.parseFloat(edgeTransform.match(/translate\(0px, ([\d.-]+)px\)/)?.[1] ?? "0");
    const stageRect = stage.getBoundingClientRect();
    const startX = stageRect.left + stageRect.width / 2;
    const startY = stageRect.top + stageRect.height / 2;
    const beforeDrag = edgeTransform;
    const dragDeltaY = edgeY >= 0 ? -60 : 60;
    fireEvent.pointerDown(stage, { pointerId: 3, pointerType: "mouse", button: 0, buttons: 1, clientX: startX, clientY: startY });
    fireEvent.pointerMove(stage, { pointerId: 3, pointerType: "mouse", buttons: 1, clientX: startX, clientY: startY + dragDeltaY });
    fireEvent.pointerUp(stage, { pointerId: 3, pointerType: "mouse", button: 0, buttons: 0, clientX: startX, clientY: startY + dragDeltaY });
    expect(image.style.transform).not.toBe(beforeDrag);
    fireEvent.doubleClick(image);
    expect(within(dialog).getByRole("button", { name: "Zoom level 391%; reset zoom" })).toBeVisible();
    fireEvent.pointerDown(stage, { pointerId: 6, pointerType: "mouse", button: 2, buttons: 2, clientX: startX, clientY: startY });
    const beforeRightClickMove = image.style.transform;
    fireEvent.pointerMove(stage, { pointerId: 6, pointerType: "mouse", buttons: 0, clientX: startX + 80, clientY: startY + 80 });
    expect(image.style.transform).toBe(beforeRightClickMove);
    fireEvent.pointerDown(stage, { pointerId: 7, pointerType: "mouse", button: 0, buttons: 1, clientX: startX, clientY: startY });
    fireEvent.pointerMove(stage, { pointerId: 7, pointerType: "mouse", buttons: 1, clientX: startX, clientY: startY + 30 });
    fireEvent.pointerMove(stage, { pointerId: 7, pointerType: "mouse", buttons: 0, clientX: startX, clientY: startY + 80 });
    const afterLostMouseRelease = image.style.transform;
    fireEvent.pointerMove(stage, { pointerId: 7, pointerType: "mouse", buttons: 0, clientX: startX, clientY: startY + 120 });
    expect(image.style.transform).toBe(afterLostMouseRelease);
    fireEvent.click(dialog);
    expect(document.body.dataset.imageZoomClosed).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 310));
    await userEvent.keyboard("0");
    await userEvent.dblClick(image);
    const pinchStart = image.style.transform;
    fireEvent.pointerDown(stage, { pointerId: 4, pointerType: "touch", button: 0, buttons: 1, clientX: startX, clientY: startY - 30 });
    fireEvent.pointerDown(stage, { pointerId: 5, pointerType: "touch", button: 0, buttons: 1, clientX: startX, clientY: startY + 30 });
    fireEvent.pointerMove(stage, { pointerId: 5, pointerType: "touch", buttons: 1, clientX: startX, clientY: startY + 90 });
    fireEvent.pointerUp(stage, { pointerId: 4, pointerType: "touch", clientX: startX, clientY: startY - 30 });
    fireEvent.pointerUp(stage, { pointerId: 5, pointerType: "touch", clientX: startX, clientY: startY + 90 });
    expect(image.style.transform).not.toBe(pinchStart);
    await within(dialog).findByRole("button", { name: "Zoom level 400%; reset zoom" });
    fireEvent.click(dialog);
    expect(document.body.dataset.imageZoomClosed).toBeUndefined();
    await userEvent.click(dialog);
    expect(document.body.dataset.imageZoomClosed).toBe("true");
    delete document.body.dataset.imageZoomClosed;
  },
};

function PortraitGallery() {
  const [index, setIndex] = useState(0);
  const names = ["portrait-first.svg", "portrait-second.svg"];
  const url = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'%3E%3Crect width='800' height='1200' fill='%23456789'/%3E%3C/svg%3E";
  return <ImageLightboxComponent url={url} filename={names[index]} index={index} total={2}
    onClose={() => {}} onPrevious={() => setIndex(0)} onNext={() => setIndex(1)} />;
}

export const PortraitGalleryArrowNavigation: Story = {
  args: ImageLightbox.args,
  render: () => <PortraitGallery />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: portrait-first.svg" });
    await userEvent.dblClick(within(dialog).getByAltText("portrait-first.svg"));
    await within(dialog).findByRole("button", { name: "Zoom level 200%; reset zoom" });
    await userEvent.keyboard("{ArrowRight}");
    const nextDialog = await page.findByRole("dialog", { name: "Image preview: portrait-second.svg" });
    await within(nextDialog).findByRole("button", { name: "Zoom level 100%; reset zoom" });
  },
};

function WideGallery() {
  const [index, setIndex] = useState(0);
  const names = ["wide-first.svg", "wide-second.svg"];
  const url = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='600'%3E%3Crect width='1600' height='600' fill='%23456789'/%3E%3C/svg%3E";
  return <ImageLightboxComponent url={url} filename={names[index]} index={index} total={2}
    onClose={() => {}} onPrevious={() => setIndex(0)} onNext={() => setIndex(1)} />;
}

export const ZoomedGalleryArrowRepeat: Story = {
  args: ImageLightbox.args,
  render: () => <WideGallery />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: wide-first.svg" });
    const toolbar = within(dialog).getByRole("group", { name: "Image zoom controls" });
    const zoomIn = within(toolbar).getByRole("button", { name: "Zoom in" });
    for (let i = 0; i < 10; i += 1) await userEvent.click(zoomIn);
    await within(toolbar).findByRole("button", { name: "Zoom level 800%; reset zoom" });
    fireEvent.keyDown(document, { key: "ArrowRight", repeat: false });
    for (let i = 0; i < 128; i += 1) fireEvent.keyDown(document, { key: "ArrowRight", repeat: true });
    expect(page.getByRole("dialog", { name: "Image preview: wide-first.svg" })).toBeVisible();
  },
};

export const MessageImageGalleryNavigation: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "storybook-large-landscape.svg", filename: "first-dashboard.svg", mime: "image/svg+xml", size: 1_024 },
        { id: "notes.pdf", filename: "notes.pdf", mime: "application/pdf", size: 2_048 },
        { id: "storybook-portrait.svg", filename: "second-dashboard.svg", mime: "image/svg+xml", size: 1_024 },
        { id: "clip.mp4", filename: "clip.mp4", mime: "video/mp4", size: 4_096 },
        { id: "storybook-wide.svg", filename: "third-dashboard.svg", mime: "image/svg+xml", size: 1_024 },
      ],
    },
  },
  parameters: { docs: { description: { story: "A single message with images mixed among other files. The modal navigates only its three previewable images." } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Preview first-dashboard.svg" }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: first-dashboard.svg" });
    const firstControls = within(dialog);
    expect(firstControls.getByText("Image 1 of 3")).toBeVisible();
    expect(firstControls.getByRole("button", { name: "Previous image" })).toBeDisabled();
    const toolbar = page.getByRole("group", { name: "Image zoom controls" });
    const counter = page.getByText("Image 1 of 3");
    const toolbarRect = toolbar.getBoundingClientRect();
    const counterRect = counter.getBoundingClientRect();
    expect(toolbarRect.bottom).toBeLessThanOrEqual(counterRect.top);
    const fittedImageRect = within(dialog).getByAltText("first-dashboard.svg").getBoundingClientRect();
    expect(toolbarRect.top).toBeGreaterThanOrEqual(fittedImageRect.bottom);
    const closeRect = page.getByRole("button", { name: "Close image preview" }).getBoundingClientRect();
    expect(closeRect.bottom).toBeLessThanOrEqual(fittedImageRect.top);
    await userEvent.click(firstControls.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(firstControls.getByRole("button", { name: "Next image" }));
    await expect(page.findByRole("dialog", { name: "Image preview: second-dashboard.svg" })).resolves.toBeVisible();
    expect(page.getByRole("button", { name: "Zoom level 100%; reset zoom" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Next image" }));
    expect(page.getByText("Image 3 of 3")).toBeVisible();
    expect(page.getByRole("button", { name: "Next image" })).toBeDisabled();
    await userEvent.keyboard("{ArrowLeft}");
    expect(page.getByText("Image 2 of 3")).toBeVisible();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(page.getByText("Image 2 of 3")).toBeVisible();
    const close = page.getByRole("button", { name: "Close image preview" });
    close.focus();
    await userEvent.keyboard("{Tab}");
    expect(page.getByRole("button", { name: "Zoom out" })).toHaveFocus();
    await userEvent.click(close);
    expect(canvas.getByRole("button", { name: "Preview first-dashboard.svg" })).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Preview first-dashboard.svg" }));
  },
};

export const LongAndZeroByteFiles: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        {
          id: "empty",
          filename: "empty.txt",
          mime: "text/plain",
          size: 0,
        },
        {
          id: "long",
          filename: `${"responsive-component-contract-".repeat(4)}.pdf`,
          mime: "application/pdf",
          size: 9_437_184,
        },
      ],
    },
  },
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: {
    docs: { description: { story: "Exercises the edge cases for a zero-byte file (`0 B`) and truncation of a very long filename on a 320px-wide phone." } },
  },
};

export const ImageFailureAndRetry: Story = {
  args: ImageLightbox.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const image = canvas.getByAltText("responsive-layout-preview.svg");
    image.dispatchEvent(new Event("error"));
    await expect(canvas.findByText("Image preview unavailable")).resolves.toBeVisible();
    expect(canvas.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank");
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      const retried = canvas.getByAltText("responsive-layout-preview.svg") as HTMLImageElement;
      expect(retried.complete && retried.naturalWidth > 0).toBe(true);
    }, { timeout: 5000 });
    expect(canvas.queryByText("Image preview unavailable")).not.toBeInTheDocument();
  },
};
