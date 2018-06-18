'use strict';

// Load the AWS SDK for Node.js
var AWS = require('aws-sdk');

// Create the WorkSpaces service object
var workspaces = new AWS.WorkSpaces({
    apiVersion: '2015-04-08'
});

// Create the Step Functions service object
var stepfunctions = new AWS.StepFunctions();

// Create the Lambda service object
var lambda = new AWS.Lambda();

exports.handler = (event, context, callback) => {

    var originURL = process.env.ORIGIN_URL || '*'; // Origin URL to allow for CORS
    var stateMachine = process.env.STATE_MACHINE_ARN || 'arn:aws:states:ap-southeast-2:240696153881:stateMachine:WSPortal-StateMachine'; // State Machine for 'create' action.
    var detailsLambda = process.env.DETAILS_LAMBDA || 'wsportal-serverless-stack-workspacesDetails-ZTNJ1D599XAC';

    console.log('Received event:', JSON.stringify(event, null, 2)); // Output log for debugging purposes.

    // The 'action' parameter specifies what workspaces control should do. Accepted values: list, acknowledge, create, rebuild, reboot, delete, bundles.
    const request = JSON.parse(event.body);
    const action = request.action;

    console.log("action: " + action);

    if (action == "list") {
        // 'list' handles outputting the WorkSpace details assigned to the user that submits the API call. 
        // If no workspace is found, currently just responds with an error which is handled client-side.

        // The 'email' value within the Cognito token is used to determine ownership, which is checked agaisnt the 'SelfServiceManaged' tag value.
        // The tag value is used for ownership detection in order to avoid integrating with Directory Services directly.
        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);

        var params = [];
        var describeWorkspacesParams = []
        // Obtain a list of all WorkSpaces, then parse the returned list to find the one with a 'SelfServiceManaged' tag
        // that equals the email address of the Cognito token, then take the ID of that WorkSpace and return all of its details back.
               
        workspaces.describeWorkspaces(describeWorkspacesParams, (err, data) => {
            // console.log("data1"+JSON.stringify(data));
            if (err) {
              console.log(err, err.stack); // an error occurred
              return;
            }
          
            // [{ id: 1}, {id: 2}]
            data.Workspaces.forEach((workspaceDetails) => {
              console.log('>>>>>>>>>>>>>>>>>>');
              console.log(`Current ID wokspaces is = ${workspaceDetails.WorkspaceId}`);
              const describeTagsParams = {
                ResourceId: workspaceDetails.WorkspaceId,
              };
          
              return workspaces.describeTags(describeTagsParams, (error, tagData) => {
                console.log(`data2${  JSON.stringify(tagData)}`);
                console.log(`describeparam${  JSON.stringify(describeTagsParams)}`);
                if (error) {
                  console.log(error, error.stack);
                  return;
                }
          
                const emailsHasFound = tagData.TagList.some(tagList =>
                  tagList.Key === 'SelfServiceManaged' &&
                  tagList.Value === event.requestContext.authorizer.claims.email
                );
          
                console.log(`Desktop for '${event.requestContext.authorizer.claims.email}' found: ${emailsHasFound}. Workspace: ${JSON.stringify(workspaceDetails)}`);
                const response = {
                  WorkspaceId: workspaceDetails.WorkspaceId,
                  UserName: workspaceDetails.UserName,
                  State: workspaceDetails.State,
                  BundleId: workspaceDetails.BundleId,
                };
          
                if (emailsHasFound) {
                  console.log(`Response: '${JSON.stringify(response)}`);
                  return callback(null, {
                    statusCode: 200,
                    body: JSON.stringify(response),
                    headers: {
                      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                      'Access-Control-Allow-Methods': 'GET,OPTIONS',
                      'Access-Control-Allow-Origin': originURL,
                    },
                  });
                } else {
                  console.log(`Tag not found for workspace ${JSON.stringify(workspaceDetails)}. tags: ${JSON.stringify(tagData.TagList)}`);
                }
                
              });
            });
          });

    } else if (action == "details") {
        var payloadString = JSON.stringify({
            "action": "get",
            "requesterEmailAddress": event.requestContext.authorizer.claims.email
        });
        var detailsParams = {
            FunctionName: detailsLambda,
            Payload: JSON.stringify({
                "body": payloadString
            })
        };

        lambda.invoke(detailsParams, function (err, data) {
            if (err) {
                console.log(err, err.stack);
            } else {
                console.log("Data: " + JSON.stringify(data));

                console.log("Payload: " + data.Payload);

                for (var i = 0; i < JSON.parse(data.Payload).length; i++) {
                    console.log("Username #" + i + ": " + JSON.parse(data.Payload)[i].Username.S)
                }

                callback(null, {
                    "statusCode": 200,
                    "body": data.Payload,
                    "headers": {
                        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                        "Access-Control-Allow-Methods": "GET,OPTIONS",
                        "Access-Control-Allow-Origin": originURL
                    }
                });

            }
        });


    } else if (action == "acknowledge") { 
        var payloadString = JSON.stringify({
            "action": "put",
            "requesterEmailAddress": event.requestContext.authorizer.claims.email,
            "requesterUsername": JSON.parse(event.body)["username"],
            "ws_status": "Acknowledged"
        });

        var ackParams = {
            FunctionName: detailsLambda,
            Payload: JSON.stringify({
                "body": payloadString
            })
        };

        lambda.invoke(ackParams, function (err, data) {
            if (err) {
                console.log(err, err.stack);
            } else {
                console.log("Data: " + JSON.stringify(data));

                callback(null, {
                    "statusCode": 200,
                    "body": data.Payload,
                    "headers": {
                        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                        "Access-Control-Allow-Methods": "GET,OPTIONS",
                        "Access-Control-Allow-Origin": originURL
                    }
                });

            }
        });

    } else if (action == "create") {
        // 'create' handles creation by initiating the Step Functions State Machine. The State Machine first sends an email
        // to the configured Approver email address with two links: one to approve and one to decline. If the Approver declines, 
        // the process ends. If the Approver approves, the next State Machine calls another Lambda function 'workspaces-create' that
        // actually handles creating the WorkSpace.

        console.log("API response data");
        console.log(JSON.parse(event.body));
        var stepParams = {
            stateMachineArn: stateMachine,
           
            /* required */
            input: JSON.stringify({
                
                "action": "put",
                "requesterEmailAddress": event.requestContext.authorizer.claims.email,
                "requesterUsername": JSON.parse(event.body)["username"],
                "requesterBundle": JSON.parse(event.body)["bundle"],
                "ws_status": "Requested"
                
            })
        };
        stepfunctions.startExecution(stepParams, function (err, data) {
            if (err) {
                console.log(err, err.stack);
            } else {
                console.log(data);
                callback(null, {
                    statusCode: 200,
                    body: JSON.stringify({
                        Result: data,
                    }),
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
        });
    } else if (action == "rebuild") {
        // 'rebuild' handles rebuilding the WorkSpace assigned to the user that submits the API call. 
        // A rebuild function resets the WorkSpace back to its original state. Applications or system settings changes
        // will be lost during a rebuild. The Data Drive is recreated from the last snapshot; snapshots are taken every 12 hours.

        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);
        console.log('Request params:' + JSON.stringify(request));
        const WorkspaceId = request.WorkspaceId;
        var rebuildParams = {
            RebuildWorkspaceRequests: [{ WorkspaceId }]
        };

        console.log('rebuild params: '+ JSON.stringify(rebuildParams));

        workspaces.rebuildWorkspaces(rebuildParams, function (err, data) {
            if (err) {
                console.log("Error: " + err);
                return callback(null, {
                    statusCode: 500,
                    body: JSON.stringify({
                        Error: err,
                    }),
                    headers: {
                        'Access-Control-Allow-Origin': '*', // isso aqui é falha de seguranca... vou deixar por enquanto, mas tem que remover
                    },
                });
            }

            console.log("Result: " + JSON.stringify(data));

            callback(null, {
                "statusCode": 200,
                "body": JSON.stringify({
                    Result: data
                }),
                "headers": {
                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                    "Access-Control-Allow-Methods": "GET,OPTIONS",
                    "Access-Control-Allow-Origin": originURL
                }
            });
        });

        } else if (action == "reboot") {
        // 'rebuild' handles rebooting the WorkSpace assigned to the user that submits the API call. 

        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);
        console.log('Request params:' + JSON.stringify(request));
        const WorkspaceId = request.WorkspaceId;
        var rebootParams = {
            RebootWorkspaceRequests: [{ WorkspaceId }]
        };

        console.log('reboot params: '+ JSON.stringify(rebootParams));

        workspaces.rebootWorkspaces(rebootParams, function (err, data) {
            if (err) {
                console.log("Error: " + err);
                return callback(null, {
                    statusCode: 500,
                    body: JSON.stringify({
                        Error: err,
                    }),
                    headers: {
                        'Access-Control-Allow-Origin': '*', // isso aqui é falha de seguranca... vou deixar por enquanto, mas tem que remover
                    },
                });
            }

            console.log("Reboot Result: " + JSON.stringify(data));

            callback(null, {
                "statusCode": 200,
                "body": JSON.stringify({
                    Result: data
                }),
                "headers": {
                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                    "Access-Control-Allow-Methods": "GET,OPTIONS",
                    "Access-Control-Allow-Origin": originURL
                }
            });
        });
    } else if (action == "delete") {
        // 'delete' handles deleting the WorkSpace assigned to the user that submits the API call. 
        // This is a permanent action and cannot be undone. No data will persist after removal.

        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);
        console.log('Request params:' + JSON.stringify(request));
        const WorkspaceId = request.WorkspaceId;

        var deletionParams = {
            TerminateWorkspaceRequests: [{ WorkspaceId }]
        };
        console.log('delete params: '+ JSON.stringify(deletionParams));

        workspaces.terminateWorkspaces(deletionParams, function (err, data) {
            if (err) {
                console.log("Error: " + err);
                callback(null, {
                    statusCode: 500,
                    body: JSON.stringify({
                        Error: err,
                    }),
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } else {
                console.log("Result: " + JSON.stringify(data));

                callback(null, {
                    "statusCode": 200,
                    "body": JSON.stringify({
                        Result: data
                    }),
                    "headers": {
                        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                        "Access-Control-Allow-Methods": "GET,OPTIONS",
                        "Access-Control-Allow-Origin": originURL
                    }
                });
            }
        });

    } else if (action == "bundles") {
        // 'bundles' handles returning the list of WorkSpaces bundles available to use. The WorkSpaces API only returns a page at a time, so we must recursively 
        // make the call to describeWorkspaceBundles until NextToken is null.
        // We must make the API call twice to return bundles owned by AMAZON and custom bundles.

        var bundleList = [];

        function getBundles(parameters, cb) {
            workspaces.describeWorkspaceBundles(parameters, function (err, data) {
                if (err) {
                    callback(null, {
                        statusCode: 500,
                        body: JSON.stringify({
                            Error: err,
                        }),
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                } else {
                    for (var i = 0; i < data["Bundles"].length; i++) {
                        console.log(data["Bundles"][i].BundleId + ":" + data["Bundles"][i].Name);
                        bundleList.push(data["Bundles"][i].BundleId + ":" + data["Bundles"][i].Name);
                    }
                    console.log("NextToken: " + data["NextToken"]);

                    if (data.NextToken) {
                        parameters.NextToken = data["NextToken"];
                        getBundles(parameters, cb);
                    } else {
                        cb();
                    }
                }
            });
        }

        // Get the Amazon-owned bundle list first, and then get the Customer-owned bundles next, and then return the entire list.
        getBundles({
        
            Owner: 'CMD'
        }, function () {
            getBundles({
                Owner: null
            }, function () {
                callback(null, {
                    "statusCode": 200,
                    "body": JSON.stringify({
                        Result: bundleList
                    }),
                    "headers": {
                        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                        "Access-Control-Allow-Methods": "GET,OPTIONS",
                        "Access-Control-Allow-Origin": originURL
                    }
                });
            });
        });

    } else {
        console.log("No action specified.");
        callback(null, {
            "statusCode": 500,
            "body": JSON.stringify({
                Error: "No action specified."
            }),
            "headers": {
                "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                "Access-Control-Allow-Methods": "GET,OPTIONS",
                "Access-Control-Allow-Origin": originURL
            }
        });
    }

}
