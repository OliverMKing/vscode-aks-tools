import { API, CloudExplorerV1 } from 'vscode-kubernetes-tools-api';
import AksClusterTreeItem from "../../tree/aksClusterTreeItem";
import { getCloudType, parseResource } from "../../azure-api-utils";
import * as azcs from '@azure/arm-containerservice';
import { Errorable } from './errorable';
import { ResourceManagementClient } from '@azure/arm-resources';
import { SubscriptionTreeNode } from '../../tree/subscriptionTreeItem';

export interface ClusterARMResponse {
    readonly id: string;
    readonly name: string;
    readonly location: string;
    readonly resourceGroup?: string;
    readonly properties: any;
    readonly type: string;
}

export enum ClusterStartStopState {
    Started = 'Started',
    Starting = 'Starting',
    Stopped = 'Stopped',
    Stopping = 'Stopping'
}

export enum CloudType {
    Public = "public",
    USGov = "usgov"
}

export function getAksClusterTreeItem(commandTarget: any, cloudExplorer: API<CloudExplorerV1>): Errorable<AksClusterTreeItem> {
    if (!cloudExplorer.available) {
        return { succeeded: false, error: 'Cloud explorer is unavailable.'};
    }

    const cloudTarget = cloudExplorer.api.resolveCommandTarget(commandTarget) as CloudExplorerV1.CloudExplorerResourceNode;

    const isClusterTarget = cloudTarget !== undefined &&
        cloudTarget.cloudName === "Azure" &&
        cloudTarget.cloudResource.nodeType === "cluster";

    if (!isClusterTarget) {
        return { succeeded: false, error: 'This command only applies to AKS clusters.'};
    }

    const cluster = cloudTarget.cloudResource as AksClusterTreeItem;
    if (cluster === undefined) {
        return { succeeded: false, error: 'Cloud target cluster resource is not of type AksClusterTreeItem.'};
    }

    return { succeeded: true, result: cluster };
}

export function getAksClusterSubscriptionItem(commandTarget: any, cloudExplorer: API<CloudExplorerV1>): Errorable<SubscriptionTreeNode> {
    if (!cloudExplorer.available) {
        return { succeeded: false, error: 'Cloud explorer is unavailable.'};
    }

    const cloudTarget = cloudExplorer.api.resolveCommandTarget(commandTarget) as CloudExplorerV1.CloudExplorerResourceNode;

    const isAKSSubscriptionTarget = cloudTarget !== undefined &&
        cloudTarget.cloudName === "Azure" &&
        cloudTarget.cloudResource.nodeType === "subscription";

    if (!isAKSSubscriptionTarget) {
        return { succeeded: false, error: 'This command only applies to AKS subscription.'};
    }

    const cloudResource = cloudTarget.cloudResource as SubscriptionTreeNode;
    if (cloudResource === undefined) {
        return { succeeded: false, error: 'Cloud target cluster resource is not of type AksClusterSubscriptionItem.'};
    }

    return { succeeded: true, result: cloudResource };
}

export async function getKubeconfigYaml(target: AksClusterTreeItem): Promise<Errorable<string>> {
    const { resourceGroupName, name } = parseResource(target.id!);
    if (!resourceGroupName || !name) {
        return { succeeded: false, error: `Invalid ARM id ${target.id}`};
    }

    const client = getContainerClient(target);
    let clusterUserCredentials: azcs.CredentialResults;

    try {
        clusterUserCredentials = await client.managedClusters.listClusterUserCredentials(resourceGroupName, name);
    } catch (e) {
        return { succeeded: false, error: `Failed to retrieve user credentials for cluster ${name}: ${e}`};
    }

    const kubeconfigCredResult = clusterUserCredentials.kubeconfigs!.find((kubeInfo) => kubeInfo.name === "clusterUser");
    if (kubeconfigCredResult === undefined) {
        return { succeeded: false, error: `No "clusterUser" kubeconfig found for cluster ${name}.`};
    }

    const kubeconfig = kubeconfigCredResult.value?.toString();
    if (kubeconfig === undefined) {
        return { succeeded: false, error: `Empty kubeconfig for cluster ${name}.` };
    }

    return { succeeded: true, result: kubeconfig };
}

export async function getClusterProperties(
    target: AksClusterTreeItem,
    clusterName: string
): Promise<Errorable<ClusterARMResponse>> {
    try {
        const client = new ResourceManagementClient(target.subscription.credentials, target.subscription.subscriptionId, { noRetryPolicy: true });
        const clusterInfo = await client.resources.get(target.resourceGroupName, target.resourceType, "", "", clusterName, "2022-02-01");

        return { succeeded: true, result: <ClusterARMResponse>clusterInfo };
    } catch (ex) {
        return { succeeded: false, error: `Error invoking ${clusterName} managed cluster: ${ex}` };
    }
}

export async function determineClusterState(
    target: AksClusterTreeItem,
    clusterName: string
): Promise<Errorable<string>> {
    try {
        const containerClient = getContainerClient(target);
        const clusterInfo = (await containerClient.managedClusters.get(target.resourceGroupName, clusterName));

        if ( clusterInfo.provisioningState !== "Stopping" && clusterInfo.agentPoolProfiles?.every((nodePool) => nodePool.powerState?.code === "Stopped") ) {
            return { succeeded: true, result: ClusterStartStopState.Stopped };
        } else if ( clusterInfo.provisioningState === "Succeeded" && clusterInfo.agentPoolProfiles?.every((nodePool) => nodePool.powerState?.code === "Running") ) {
            return { succeeded: true, result: ClusterStartStopState.Started };
        } else if (clusterInfo.provisioningState === "Stopping") {
            return { succeeded: true, result:  ClusterStartStopState.Stopping };
        } else {
            return { succeeded: true, result:  ClusterStartStopState.Starting };
        }

    } catch (ex) {
        return { succeeded: false, error: `Error invoking ${clusterName} managed cluster: ${ex}` };
    }
}

export async function startCluster(
    target: AksClusterTreeItem,
    clusterName: string,
    clusterState: string
): Promise<Errorable<string>> {
    try {
        const containerClient = getContainerClient(target);

        if (clusterState === ClusterStartStopState.Stopped ) {
            containerClient.managedClusters.beginStartAndWait(target.resourceGroupName, clusterName, undefined);
        } else if ( clusterState === ClusterStartStopState.Stopping) {
            return { succeeded: false, error: `Cluster ${clusterName} is in Stopping state wait until cluster is fully stopped.` };
        } else {
            return { succeeded: false, error: `Cluster ${clusterName} is already Started.` };
        }

        return { succeeded: true, result: "Start cluster succeeded." };
    } catch (ex) {
        return { succeeded: false, error: `Error invoking ${clusterName} managed cluster: ${ex}` };
    }
}

export async function stopCluster(
    target: AksClusterTreeItem,
    clusterName: string,
    clusterState: string
): Promise<Errorable<string>> {
    try {
        const containerClient = getContainerClient(target);

        if (clusterState === ClusterStartStopState.Started) {
            containerClient.managedClusters.beginStopAndWait(target.resourceGroupName, clusterName, undefined);
        }  else {
            return { succeeded: false, error: `Cluster ${clusterName} is either Stopped or in Stopping state.` };
        }

        return { succeeded: true, result: "Stop cluster succeeded." };
    } catch (ex) {
        return { succeeded: false, error: `Error invoking ${clusterName} managed cluster: ${ex}` };
    }
}

export async function getWindowsNodePoolKubernetesVersions(
    containerClient: azcs.ContainerServiceClient,
    resourceGroupName: string,
    clusterName: string
): Promise<Errorable<string[]>> {
    try {
        const k8sVersions: string[] = [];
        for await (let page of containerClient.agentPools.list(resourceGroupName, clusterName).byPage()) {
            for (const nodePool of page) {
                if (!nodePool.osType) {
                    return { succeeded: false, error: `OS type not available for node pool ${nodePool.name} for cluster ${clusterName}` };
                }
    
                if (nodePool.osType.toUpperCase() === "WINDOWS") {
                    if (!nodePool.currentOrchestratorVersion) {
                        return { succeeded: false, error: `Kubernetes version not available for node pool ${nodePool.name} for cluster ${clusterName}` };
                    }

                    k8sVersions.push(nodePool.currentOrchestratorVersion);
                }
            }
        }

        return { succeeded: true, result: k8sVersions };
    } catch (ex) {
        return { succeeded: false, error: `Error retrieving Windows node pool Kubernetes versions for ${clusterName}: ${ex}` };
    }
}

export function getContainerClient(target: AksClusterTreeItem): azcs.ContainerServiceClient {
    const cloudType = getCloudType(target);

    switch (cloudType){
        case CloudType.USGov:
            return new azcs.ContainerServiceClient(target.subscription.credentials, target.subscription.subscriptionId, {endpoint:  "https://management.usgovcloudapi.net"});
        default:
            return new azcs.ContainerServiceClient(target.subscription.credentials, target.subscription.subscriptionId);
    }
}