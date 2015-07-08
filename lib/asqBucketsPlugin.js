var ASQPlugin = require('asq-plugin');
var ObjectId = require('mongoose').Types.ObjectId;
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var assert = require('assert');
var _ = require('lodash');


//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-buckets-q',

  hooks:{
    "parse_html"          : "parseHtml",
    "answer_submission"   : "answerSubmission",
    "presenter_connected" : "presenterConnected",
    "viewer_connected"    : "viewerConnected"
  },

  parseHtml: function(option){
    var $ = cheerio.load(option.html, {decodeEntities: false});
    var questions = [];

    $(this.tagName).each(function(idx, el){
      questions.push(this.processEl($, el));
    }.bind(this));

    option.html = $.root().html();

    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(questions)
    .then(function(){
      return Promise.resolve(option);
    });
    
  },

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for a multi-choice question
    if(question.type !=='asq-buckets-q') {
      return answer;
    }

    assert(_.isArray(answer.submission),
      'Invalid answer format, answer.submission should be an array.');

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      type       : question.type,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    console.log('when submitted: ', answer.submission);

    //this will be the argument to the next hook
    return answer;
  }),

  processEl: function($, el){

    var $el = $(el);

    //make sure question has a unique id
    var uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    } 

    //get stem
    var stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    valueattr = $el.attr('valueattr') ? $el.attr('valueattr') : 'name';

    // targets
    var targetsNode = $el;
    var targetsAttr = $el.attr('targets');
    if ( targetsAttr && $el.find(targetsAttr).length ) {
      targetsNode =  $el.children(targetsAttr)[0]
    } 
    var targets = $(targetsNode).children('[target]');
    targets = $(targets).map(function(index, t) {
      return $(t).attr(valueattr) ? $(t).attr(valueattr) : $(t).html();
    }).toArray();

    // objects
    var objectsNode = $el;
    var objectsAttr = $el.attr('objects');
    if ( objectsAttr && $el.find(objectsAttr).length ) {
      objectsNode =  $el.children(objectsAttr)[0]
    } 
    var objects = $(objectsNode).children('[object]');
    objects = $(objects).map(function(index, t) {
      return $(t).attr(valueattr) ? $(t).attr(valueattr) : $(t).html();
    }).toArray();

    return {
      _id : uid,
      type: this.tagName,
      data: {
        stem: stem,
        targets: targets,
        objects: objects
      }
    }

  },

  // keep empty
  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){
    return null;    
  }),

  // keep empty
  presenterConnected: coroutine(function *presenterConnectedGen (info){
    if(! info.session_id) return info;

    var questionsWithScores = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithScores,
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  
  restoreViewerForSession: coroutine(function *restoreViewerForSessionGen(session_id, presentation_id, whitelistId){
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          "session": session_id,
          "answeree" : whitelistId,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1} },
      { $group:{
          "_id": "$question",
          "matches": {$first:"$submission"},
        }
      },
      { $project:{
          "_id": 0,
          "uid" : "$_id",
          "matches": 1,
        }
      }
    ]
    var questionsWithAnswers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    return questionsWithAnswers;    
  }),
  
  viewerConnected: coroutine(function *viewerConnectedGen (info){
    if(! info.session_id) return info;

    var questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);

    var event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)
    // this will be the argument to the next hook
    return info;
  }),


});