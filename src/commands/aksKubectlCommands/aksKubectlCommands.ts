import * as vscode from "vscode";
import * as k8s from "vscode-kubernetes-tools-api";
import { IActionContext } from "@microsoft/vscode-azext-utils";
import { JSONPath } from "jsonpath-plus";
import stripAnsi from "strip-ansi";
import { getAksClusterTreeItem } from "../utils/clusters";
import { getExtensionPath, longRunning } from "../utils/host";
import { Errorable, failed } from "../utils/errorable";
import * as tmpfile from "../utils/tempfile";
import * as clusters from "../utils/clusters";
import AksClusterTreeItem from "../../tree/aksClusterTreeItem";
import {
  createWebView,
  getRenderedContent,
  getResourceUri,
  getNodeModuleUri,
} from "../utils/webviews";
import { invokeKubectlCommand } from "../utils/kubectl";

interface IWebviewGetter {
  (
    cmdOutput: string,
    commandRun: string,
    vscodeExtensionPath: string,
    webview: vscode.Webview
  ): string;
}

interface ITable {
  table: string[][];
  headers: string[];
}

interface ITableGetter {
  (cmdOutput: string): ITable;
}

interface IColGetter {
  (cmdOutput: string): string[];
}

interface ICol {
  colGetter: IColGetter;
  name: string;
}

export async function aksKubectlGetPodsCommands(
  _context: IActionContext,
  target: any
): Promise<void> {
  const command = `get pods --all-namespaces -o json`;
  await aksKubectlCommands(
    _context,
    target,
    command,
    getTableWebviewGetter(
      jsonPathTableGetter([
        {
          colGetter: getJsonPathCol("$.items[*].metadata.name"),
          name: "Name",
        },
        {
          name: "Ready",
          colGetter: getJsonPathColWithModifier(
            "$.items[*].status.containerStatuses",
            (val) => {
              const objs: any[] = JSON.parse(JSON.stringify(val));
              const readyCount = objs.reduce((acc, obj) => {
                if (obj?.ready) acc++;

                return acc;
              }, 0);

              return `${readyCount}/${objs.length}`;
            }
          ),
        },
        {
          name: "Status",
          colGetter: getJsonPathColWithModifier(
            "$.items[*].status.containerStatuses",
            (val) => {
              const objs: any[] = JSON.parse(JSON.stringify(val));
              let state = "Running";
              for (const obj of objs) {
                if (obj?.state?.running) continue;

                const reason = obj?.state?.waiting?.reason;
                if (reason) state = reason;
              }

              return state;
            }
          ),
        },
        {
          colGetter: getJsonPathCol(
            "$.items[*].status.containerStatuses[0].restartCount"
          ),
          name: "Restarts",
        },
        {
          colGetter: getJsonPathColWithModifier(
            "$.items[*].status.containerStatuses[0].state",
            (val) => {
              const obj = JSON.parse(JSON.stringify(val));
              const started = obj?.running?.startedAt;
              if (started) {
                // TODO: this should all be switched to a helper library later on
                // this is just a proof of concept
                const date = Date.parse(started);
                const now = Date.now();
                const days = Math.floor((now - date) / (1000 * 60 * 60 * 24));
                if (days > 0) return `${days} day${days > 1 ? "s" : ""}`;

                const hours = Math.floor((now - date) / (1000 * 60 * 60));
                if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}`;

                const minutes = Math.floor((now - date) / (1000 * 60));
                if (minutes > 0) {
                  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
                }
              }

              return "0d";
            }
          ),
          name: "Age",
        },
      ])
    )
  );
}

export async function aksKubectlGetClusterInfoCommands(
  _context: IActionContext,
  target: any
): Promise<void> {
  const command = `cluster-info`;
  await aksKubectlCommands(_context, target, command, getBasicWebviewContent);
}

export async function aksKubectlGetAPIResourcesCommands(
  _context: IActionContext,
  target: any
): Promise<void> {
  const command = `api-resources`;
  await aksKubectlCommands(_context, target, command, getBasicWebviewContent);
}

export async function aksKubectlGetNodeCommands(
  _context: IActionContext,
  target: any
): Promise<void> {
  const command = `get node -o json`;
  await aksKubectlCommands(
    _context,
    target,
    command,
    getTableWebviewGetter(
      jsonPathTableGetter([
        { colGetter: getJsonPathCol("$.items[*].metadata.name"), name: "Name" },
        {
          colGetter: getJsonPathCol("$.items[*].status.conditions[-1:].type"),
          name: "Status",
        },
        {
          colGetter: getJsonPathCol(
            "$.items[*].status.nodeInfo.kubeletVersion"
          ),
          name: "Version",
        },
      ])
    )
  );
}

export async function aksKubectlDescribeServicesCommands(
  _context: IActionContext,
  target: any
): Promise<void> {
  const command = `describe services`;
  await aksKubectlCommands(_context, target, command, getBasicWebviewContent);
}

async function aksKubectlCommands(
  _context: IActionContext,
  target: any,
  command: string,
  webviewGetter: IWebviewGetter
): Promise<void> {
  const kubectl = await k8s.extension.kubectl.v1;
  const cloudExplorer = await k8s.extension.cloudExplorer.v1;

  if (!kubectl.available) {
    vscode.window.showWarningMessage(`Kubectl is unavailable.`);
    return undefined;
  }

  const cluster = getAksClusterTreeItem(target, cloudExplorer);
  if (failed(cluster)) {
    vscode.window.showErrorMessage(cluster.error);
    return;
  }

  const extensionPath = getExtensionPath();
  if (failed(extensionPath)) {
    vscode.window.showErrorMessage(extensionPath.error);
    return;
  }

  const clusterKubeConfig = await clusters.getKubeconfigYaml(cluster.result);
  if (failed(clusterKubeConfig)) {
    vscode.window.showErrorMessage(clusterKubeConfig.error);
    return undefined;
  }

  const kubectlresp = await kubectlCommandRun(
    cluster.result,
    extensionPath.result,
    clusterKubeConfig.result,
    command,
    kubectl
  );
  if (failed(kubectlresp)) {
    vscode.window.showErrorMessage(kubectlresp.error);
    return;
  }
  const resultoutput = stripAnsi(kubectlresp.result.stdout);

  const clustername = cluster.result.name;
  const webview = createWebView(
    "AKS Kubectl Commands",
    `AKS Kubectl Command view for: ${clustername}`
  ).webview;

  webview.html = webviewGetter(
    resultoutput,
    command,
    extensionPath.result,
    webview
  );
}

async function kubectlCommandRun(
  cloudTarget: AksClusterTreeItem,
  extensionPath: string,
  clusterConfig: string,
  command: string,
  kubectl: k8s.APIAvailable<k8s.KubectlV1>
): Promise<Errorable<k8s.KubectlV1.ShellResult>> {
  const clustername = cloudTarget.name;
  return await longRunning(
    `Loading ${clustername} kubectl command run.`,
    async () => {
      return await tmpfile.withOptionalTempFile<
        Errorable<k8s.KubectlV1.ShellResult>
      >(clusterConfig, "YAML", async (kubeConfigFile) => {
        return await invokeKubectlCommand(kubectl, kubeConfigFile, command);
      });
    }
  );
}

function getBasicWebviewContent(
  cmdOutput: string,
  commandRun: string,
  vscodeExtensionPath: string,
  webview: vscode.Webview
): string {
  const toolkitUri = getNodeModuleUri(webview, vscodeExtensionPath, [
    "node_modules",
    "@vscode",
    "webview-ui-toolkit",
    "dist",
    "toolkit.js",
  ]);
  const templateUri = getResourceUri(
    vscodeExtensionPath,
    "aksKubectlCommand",
    "akskubectlcommandbasic.html"
  );
  const data = {
    name: commandRun,
    command: cmdOutput,
    toolkituri: toolkitUri,
  };

  return getRenderedContent(templateUri, data);
}

function getJsonPathColWithModifier(
  jsonPath: string,
  modifier: (val: string) => string
): IColGetter {
  return (cmdOutput: string) => {
    const cols = getJsonPathCol(jsonPath)(cmdOutput);
    return cols.map(modifier);
  };
}

function getJsonPathCol(jsonPath: string): IColGetter {
  return (cmdOutput: string) => {
    const obj = JSON.parse(cmdOutput);
    return JSONPath({ path: jsonPath, json: obj });
  };
}

function jsonPathTableGetter(cols: ICol[]): ITableGetter {
  return (cmdOutput: string): ITable => {
    const columns: string[][] = cols.map((col) => {
      return col.colGetter(cmdOutput);
    });
    const table: [][] = [];
    for (let row = 0; row < columns[0]?.length; row++) {
      const rowObj: any = {};
      for (let col = 0; col < columns?.length; col++) {
        rowObj[cols[col].name] = JSON.stringify(columns[col][row]);
      }
      table.push(rowObj);
    }
    const headers = cols.map((col) => col.name);

    return { table, headers };
  };
}

function getTableWebviewGetter(tableGetter: ITableGetter): IWebviewGetter {
  return (
    cmdOutput: string,
    commandRun: string,
    vscodeExtensionPath: string,
    webview: vscode.Webview
  ): string => {
    const toolkitUri = getNodeModuleUri(webview, vscodeExtensionPath, [
      "node_modules",
      "@vscode",
      "webview-ui-toolkit",
      "dist",
      "toolkit.js",
    ]);
    const templateUri = getResourceUri(
      vscodeExtensionPath,
      "aksKubectlCommand",
      "akskubectlcommandtable.html"
    );

    const { table, headers } = tableGetter(cmdOutput);
    const data = {
      name: commandRun,
      table,
      headers,
      toolkituri: toolkitUri,
    };
    return getRenderedContent(templateUri, data);
  };
}
