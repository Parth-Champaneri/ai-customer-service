const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const cors = require('cors');
const app = express();

const OpenAIApi = require('openai');

  const openai = new OpenAIApi({
    apiKey: 'Key'
  });

// Middleware to parse POST requests
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());


const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const questions = [
    { id: 'name', text: "What's your name?" },
    { id: 'dob', text: "What's your date of birth?" }
    // { id: 'insuranceName', text: "What's your insurance payer name?" },
    // { id: 'insuranceID', text: "What's your insurance ID?" },
    // { id: 'referral', text: "Do you have a referral? If yes, to whom?" },
    // { id: 'complaint', text: "What's your chief medical complaint?" },
    // { id: 'address', text: "What's your address?" },
    // { id: 'contact', text: "What's your contact information?" }
];

let responses = {};
const userStates = {};

app.get('/', (req, res) => {
    res.send("server running");
});

/*
Webhook sent by twilio
*/
app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const userPhoneNumber = req.body.From;

    // Initialize or reset the user's state
    userStates[userPhoneNumber] = {
        currentQuestionIndex: 0,
        waitingForTranscription: false
    };

    askQuestion(userPhoneNumber, twiml);

    res.type('text/xml');
    res.send(twiml.toString());
});



app.post('/handle-response', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const userPhoneNumber = req.body.From;

    if (userStates[userPhoneNumber].waitingForTranscription) {
        twiml.say("Processing");
        twiml.pause({ length: 4 });
        twiml.redirect(`/handle-response`);
    } else {
        askQuestion(userPhoneNumber, twiml);
    }

    res.type('text/xml');
    res.send(twiml.toString());
});


/*
Webhook that gets called when a transcription is ready for a user's reponse
 */
app.post('/handle-transcription', async (req, res) => {
    const userPhoneNumber = req.body.From;
    const currentQuestionIndex = userStates[userPhoneNumber].currentQuestionIndex;
    const currentQuestionId = questions[currentQuestionIndex].id;
    const transcription = req.body.TranscriptionText;

    responses[currentQuestionId] = req.body.TranscriptionText;
    console.log(`Transcription for ${currentQuestionId}: ${req.body.TranscriptionText}`);
    console.log(responses);

    const isValid = await validateWithGPT(questions[currentQuestionIndex].text, transcription);

    if (isValid) {
        userStates[userPhoneNumber].waitingForTranscription = false;
        userStates[userPhoneNumber].currentQuestionIndex++;
    } else {
        console.log(`Invalid response for ${currentQuestionId}. Asking again.`);
        userStates[userPhoneNumber].waitingForTranscription = false;
    }

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect(`/handle-response`);
    res.type('text/xml');
    res.send(twiml.toString());
});


/**
 * Asks the next question according to the state of the user
 */
function askQuestion(userPhoneNumber, twiml) {
    const userState = userStates[userPhoneNumber];
    const question = questions[userState.currentQuestionIndex];

    if (userState.currentQuestionIndex < questions.length) {
        twiml.say(question.text);
        twiml.record({
            maxLength: 30,
            action: `/handle-response`,
            transcribe: true,
            transcribeCallback: `/handle-transcription`
        });

        userState.waitingForTranscription = true;
    } else {
        twiml.say("Thank you for providing the information. We will now find the best available providers and times for you.");
        presentAvailableTimes(userPhoneNumber, twiml);
    }
}


/**
 * This function validates a question and the answer given for the question by the user using OpenAI
 */
async function validateWithGPT(question, response) {
    const prompt = `Question: ${question}\nResponse: ${response}\ Is the response valid to the question asked? (answer with only 'yes' or 'no')`;
    const result = await openai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'gpt-3.5-turbo',
    });
    console.log(result.choices[0].message.content.trim().toLowerCase());
    // console.log(result.choices[0].message.trim().toLowerCase());
    return result.choices[0].message.content.trim().toLowerCase() === 'yes';
}

/**
 * Sending confirmation as text, currently hard coded to only send confirmations to my number
 */
async function sendTextMessage(body) {
    try {
        const message = await twilioClient.messages.create({
            body: body,
            from: '+12516629197',  // This should be a number you've bought from Twilio
            to: '+16478245336'  // The recipient's phone number
        });

        console.log(`Message sent with SID: ${message.sid}`);
    } catch (error) {
        console.error("Error sending text message:", error);
    }
}

/**
 * Selecting availability
 */

const availableTimes = ["Today 10 AM", "Today 2 PM", "Today 4 PM", "Wednesday 11 AM","Friday 11 AM"];
let timeIndex = 0;

function presentAvailableTimes(userPhoneNumber, twiml) {
    if (timeIndex < availableTimes.length) {
        twiml.say(`Your available time is: ${availableTimes[timeIndex]}`);
        twiml.pause({ length: 1 });
        twiml.gather({
            numDigits: 1,
            action: `/handle-time-selection?timeIndex=${timeIndex}`,
            method: 'POST'
        }).say('Press 1 to confirm or 2 for another option.');
    } else {
        twiml.say('There are no other times available at the moment.  Goodbye!');
        twiml.hangup();
    }
}

app.post('/handle-time-selection', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const userSelection = req.body.Digits;
    const currentOption = parseInt(req.query.timeIndex, 10);

    if (userSelection === '1') {
        twiml.say(`You've selected ${availableTimes[currentOption]}. We've sent you a text to confirm!`);
        sendTextMessage(`You've selected ${availableTimes[currentOption]}.`);
        twiml.say("Goodbye!");
    } else if (userSelection === '2') {
        timeIndex++;
        presentAvailableTimes(req.body.From, twiml);
    } else {
        twiml.say('Invalid selection. Please try again.');
        presentAvailableTimes(req.body.From, twiml);
    }

    res.type('text/xml');
    res.send(twiml.toString());
});




const PORT = 4000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
