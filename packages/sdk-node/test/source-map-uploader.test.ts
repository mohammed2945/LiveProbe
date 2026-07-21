import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  remoteSourceMapPath,
  SourceMapUploader,
} from "../src/source-map-uploader.js";

describe("SourceMapUploader", () => {
  it("uploads external maps once and strips embedded source content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveprobe-source-map-"));
    try {
      const mapDirectory = join(directory, "dist", "src");
      await mkdir(mapDirectory, { recursive: true });
      await writeFile(
        join(mapDirectory, "payments.js.map"),
        JSON.stringify({
          version: 3,
          file: "payments.js",
          sources: ["../../src/payments.ts"],
          sourcesContent: ["const secret = 'must-not-upload';"],
          names: [],
          mappings: ";;;AACA",
        }),
      );
      await writeFile(join(mapDirectory, "broken.js.map"), "{not-json");
      await mkdir(join(directory, "node_modules", "ignored"), { recursive: true });
      await writeFile(
        join(directory, "node_modules", "ignored", "dependency.js.map"),
        "{}",
      );

      const uploaded: Array<{ mapPath: string; map: Record<string, unknown> }> = [];
      const warnings: string[] = [];
      const broker = {
        sourceMapStatus: vi.fn(async () => ({
          isUploader: true,
          isComplete: false,
        })),
        uploadSourceMap: vi.fn(async (input) => {
          uploaded.push({ mapPath: input.mapPath, map: input.map });
        }),
        completeSourceMaps: vi.fn(async () => undefined),
      };
      const uploader = new SourceMapUploader({
        broker,
        serviceId: "payments",
        commitSha: "abcdef1234567890",
        uploaderId: "agent-a",
        sourceMapDir: directory,
        distLocation: "dist",
        cwd: directory,
        onWarning: (message) => warnings.push(message),
      });

      await expect(uploader.sync()).resolves.toBe("uploaded");
      expect(uploaded).toEqual([
        {
          mapPath: "dist/src/payments.js.map",
          map: expect.not.objectContaining({ sourcesContent: expect.anything() }),
        },
      ]);
      expect(broker.completeSourceMaps).toHaveBeenCalledOnce();
      expect(warnings).toEqual([
        expect.stringContaining("SOURCE MAP SKIPPED dist/src/broken.js.map"),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits when another instance owns the upload and skips completed sets", async () => {
    const broker = {
      sourceMapStatus: vi
        .fn()
        .mockResolvedValueOnce({ isUploader: false, isComplete: false })
        .mockResolvedValueOnce({ isUploader: false, isComplete: true }),
      uploadSourceMap: vi.fn(),
      completeSourceMaps: vi.fn(),
    };
    const uploader = new SourceMapUploader({
      broker,
      serviceId: "payments",
      commitSha: "abcdef1234567890",
      uploaderId: "agent-b",
    });

    await expect(uploader.sync()).resolves.toBe("waiting");
    await expect(uploader.sync()).resolves.toBe("complete");
    expect(broker.uploadSourceMap).not.toHaveBeenCalled();
  });

  it("preserves an app-root/dist prefix without duplicating overlap", () => {
    expect(
      remoteSourceMapPath(
        "/workspace/demo/payment/dist/src/server.js.map",
        "/workspace",
        "demo/payment",
        "dist",
      ),
    ).toBe("demo/payment/dist/src/server.js.map");
  });
});
