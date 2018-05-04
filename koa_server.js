
const Koa = require('koa');
const Router = require('koa-router');
const views = require('koa-views');
const axios = require('axios');
const querystring = require('querystring');
const Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs'));

const app = new Koa();
const router = new Router();
const baseDialogflowURL = 'https://dialogflow.googleapis.com';

let OAUTH_TOKEN;

// x-response-time
app.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    ctx.set('X-Response-Time', '${ms}ms');
});

// logger
app.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${ctx.method} ${ctx.url} - ${ms}`);
});

// response
// use the views directory for all html stuffs
app.use(views(__dirname + '/views', { extension: 'html' }));

// render the correct html
app.use(async function (ctx) {
    let currURI = ctx.path;

    if (currURI === "/") {
        ctx.redirect("/createIntent");
    }
    else if (currURI === "/createIntent") {
        // read the token from the local token file
        OAUTH_TOKEN = await fs.readFileAsync(__dirname + "/currentToken.txt", 'utf8');

        // make google API call to check if token is still valid, then use that for the checks below
        if (await isAccessTokenValid(OAUTH_TOKEN)) {
            // move on to intent creation with token
            await ctx.render('/createIntent');
        } else {
            // get a new token
            ctx.redirect("/oauth2callback");
        }
    }
    else if (currURI === "/updateModel") {

        let query = ctx.query;
        if (query.error !== undefined)
            console.log("ERROR getting model data: ", query.error);

        let intents = JSON.parse(query.intents);

        // create the model with the intents and utterances
        await createModel(intents);

        // give signal it's time to switch
        ctx.redirect('/default');
    }
    else if (currURI === '/useModel') {

        // check if there's a query
        let query = ctx.query;
        if (query.error !== undefined)
            console.log("ERROR getting model data: ", query.error);

        // if query do search
        if (query.utterance !== undefined) {
            let resp = await detectIntent(query.utterance);
            
            // set the response to the json form google
            ctx.body = JSON.stringify(resp);
        } else {
            // first time, no query, render new html
            await ctx.render('/useModel');
        }
    }
    else if (currURI === "/oauth2callback") {
        let query = ctx.query;
        if (query.error !== undefined)
            console.log("ERROR getting token: ", query.error);

        let code = query.code;
        if (code === undefined) { // there is no code, get one
            let credHTML = await getOAuthCode();
            ctx.body = credHTML;
            await ctx.render("/oauth2callback");
        }
        else { // exchange the code for a token and save it
            let token = await getOAuthToken(code);
            if (token === undefined) { // no token, go to base page
                ctx.redirect('/default');
            }
            else { // update token and redirect to intent creator
                ctx.redirect('/createIntent');
            }
        }
    }
    else {
        await ctx.render('default');
    }
});

// configure the router
app
    .use(router.allowedMethods())
    .use(router.routes())
    .use(require("koa-body")());
// keep listening
app.listen(8008);

async function getOAuthCode() {
    // what do you use for requests? requests? axios? nothing?

    let clientJSON = await JSON.parse(fs.readFileSync('./client_secret.json', 'utf8'));
    let oauthURL = "https://accounts.google.com/o/oauth2/v2/auth";
    let scope = "https://www.googleapis.com/auth/cloud-platform";
    let response_type = "code";
    let params = querystring.stringify({
        scope: scope,
        client_id: clientJSON['web']['client_id'],
        redirect_uri: clientJSON['web']['redirect_uris'][0],
        response_type: response_type
    });
    let url = oauthURL + "?" + params;

    let credCode;
    try {
        const response = await axios.get(url);
        const data = response.data;
        credCode = data;
    }
    catch (error) {
        console.log("ERROR IN AUTHCODE: ", error);
    }


    // create a file containing google's code to open
    await fs.writeFileAsync(__dirname + "/views/oauth2callback.html", credCode, function (err) {
        if (err) console.log("ERROR IN WRITING CALLBACK FILE: ", err);
    });
    return credCode;
}

async function getOAuthToken(code) {
    let oauthURL = "https://www.googleapis.com/oauth2/v4/token";
    let clientJSON = await JSON.parse(fs.readFileSync('./client_secret.json', 'utf8'));

    let params = querystring.stringify({
        client_id: clientJSON['web']['client_id'],
        client_secret: clientJSON['web']['client_secret'],
        grant_type: "authorization_code",
        redirect_uri: clientJSON['web']['redirect_uris'][0],
        code: code
    });
    let url = oauthURL + "?" + params;

    let token;
    try {
        const response = await axios({
            method: "POST", url: url, headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
        });
        const data = response.data;
        token = data.access_token;
        // save down the token in a file
        await fs.writeFile(__dirname + "/currentToken.txt", token, function (err) {
            if (err) console.log("ERROR IN WRITING TOKEN FILE: ", err);
        });
    }
    catch (error) {
        console.log("ERROR IN AUTHTOKEN: ", error);
    }
    return token;
}

async function isAccessTokenValid(token) {
    if (token === undefined) {
        return false;
    }

    let url = "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=" + token;
    let response = undefined;
    try {
        response = await axios({
            method: "GET", url: url
        });
    }
    catch (error) {
        // there was an error, the token is invalid...
        return false;
    }

    // no error getting response, token is valid
    return true;
}

async function createModel(intents) {

    // get dialogflow client information
    let clientJSON = await JSON.parse(fs.readFileSync('./client_secret.json', 'utf8'))['web'];

    // get the agent
    let agent;
    try {
        let url = "https://dialogflow.googleapis.com/v2/projects/" + clientJSON['project_id'] + "/agent";
        const response = await axios({
            method: "GET", url: url, headers: {
                "Authorization": "Bearer " + OAUTH_TOKEN
            },
        });
        agent = response.data;
    }
    catch (error) {
        console.log("ERROR IN GETTING AGENT: ", error);
    }

    // list old intents
    let oldIntents;
    try {
        let url = "https://dialogflow.googleapis.com/v2/projects/" + clientJSON['project_id'] + "/agent/intents";
        const response = await axios({
            method: "GET",
            url: url,
            headers: {
                "Authorization": "Bearer " + OAUTH_TOKEN
            }
        });
        oldIntents = response.data.intents;
    }
    catch (error) {
        console.log("ERROR IN GETTING OLD INTETNS: ", error);
    }

    // delete old intents
    if (oldIntents !== undefined) {
        for (let oldIntent of oldIntents) {
            try {
                let url = "https://dialogflow.googleapis.com/v2/" + oldIntent.name;
                const response = await axios({
                    method: "DELETE",
                    url: url,
                    headers: {
                        "Authorization": "Bearer " + OAUTH_TOKEN
                    },
                });
            }
            catch (error) {
                console.log("ERROR IN DELETING OLD INTENTS: ", error);
            }
        }
    }

    // create and train each new intent
    for (let id of Object.keys(intents)) {
        intent = intents[id];

        let trainingPhrases = []
        for (let phrase of intent.training_utterances) {
            let curr = {
                type: 'TYPE_UNSPECIFIED',
                parts: [{
                    text: phrase
                }]
            };
            trainingPhrases.push(curr);
        }

        // create intent
        let new_intent = {
            displayName: intent.intent,
            webhookState: 0,
            trainingPhrases: trainingPhrases
        }

        try {
            let url = "https://dialogflow.googleapis.com/v2/projects/" + clientJSON['project_id'] + "/agent/intents";
            const response = await axios({
                method: "POST",
                url: url,
                headers: {
                    "Authorization": "Bearer " + OAUTH_TOKEN
                },
                data: new_intent
            });
        }
        catch (error) {
            console.log("ERROR IN CREATING NEW INTENT: ", error.response);
        }
    }
}

// detect the intent and return to user
async function detectIntent(utterance) {
    try {
        let url = "https://dialogflow.googleapis.com/v2/projects/myagent-2e503/agent/sessions/b21dffb3-4161-44b4-b136-b3677be342f5:detectIntent";
        const response = await axios({
            method: "POST",
            url: url,
            headers: {
                "Authorization": "Bearer " + OAUTH_TOKEN,
                "Content-Type": "application/json",
            },
            data: {
                "queryInput": {
                    "text": {
                        "text": utterance,
                        "languageCode": "en"
                    }
                },
                "queryParams": {
                    "timeZone": "America/New_York"
                }
            }
        });
        return response.data;
    }
    catch (error) {
        console.log("ERROR IN GETTING SESSION: ", error.response);
    }
}


