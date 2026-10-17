import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ChangesPanel } from "./changes-panel";
import { PROVIDER_ID } from "./provider-id";
import { RepoPicker } from "./repo-picker";

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: PROVIDER_ID,
    component: RepoPicker,
  });
  app.slots.threadPanelAction({
    id: "changes",
    title: "Changes",
    component: ChangesPanel,
  });
});
