import * as vscode from "vscode";
import * as k8s from "vscode-kubernetes-tools-api";
import { IActionContext } from "@microsoft/vscode-azext-utils";
import { JSONPath } from "jsonpath-plus";
import stripAnsi from 'strip-ansi';
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

interface IColumn {
  name: string;
  jsonPath: string;
}

export async function aksKubectlGetPodsCommands(
  _context: IActionContext,
  target: any
): Promise<void> {
  const command = `get pods --all-namespaces -o json`;
  await aksKubectlCommands(_context,
    target,
    command,
    getGridWebviewGetter([
      {jsonPath: "$.items[*].metadata.name", name: "Name"},
      {jsonPath: "$.items[*].status.containerStatuses[0].state", name: "State"},
      {jsonPath: "$.items[*].status.containerStatuses[0].restartCount", name: "Restarts"},
    ])
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
  const command = `get node`;
  await aksKubectlCommands(_context, target, command, getBasicWebviewContent);
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
  return await longRunning(`Loading ${clustername} kubectl command run.`, async () => {
    return await tmpfile.withOptionalTempFile<
      Errorable<k8s.KubectlV1.ShellResult>
    >(clusterConfig, "YAML", async (kubeConfigFile) => {
      return await invokeKubectlCommand(kubectl, kubeConfigFile, command);
    });
  });
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

function getGridWebviewGetter(
  cols: IColumn[]
): IWebviewGetter {
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

    const obj = JSON.parse(cmdOutput);
    const columns: string[][] = cols.map((col) => {
      return JSONPath({path: col.jsonPath, json: obj});
    });
    const table = [];
    for (let row = 0; row < columns[0]?.length; row++) {
      const rowObj: any = {};
      for (let col = 0; col < columns?.length; col++) {
        rowObj[cols[col].name] = columns[col][row];
      }
      table.push(rowObj);
    }
    const tableHeaders = cols.map(col => col.name);

    const data = {
      name: commandRun,
      table: table,
      headers: tableHeaders,
      toolkituri: toolkitUri,
    };
    return getRenderedContent(templateUri, data);
  };
}