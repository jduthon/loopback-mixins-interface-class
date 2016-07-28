/**
 * Created by jean on 7/22/2016.
 */

module.exports = function(Model, options) {
  var app = require('../../server/server');

  var recursiveExistence = function(key, obj){
    var newObj = obj[key[0]];
    return (key.length > 0 && typeof(newObj) !== "undefined") ? recursiveExistence(key.slice(1),newObj) : key.length == 0;
  };

  var hasAbstractParent = function(model){
    return recursiveExistence(["settings","mixins","AbstractClass"],model.base);
  };

  var isInternalCall = function(ctx){
    return ctx.options.internalCall;
  };

  var isConcreteModel = function(ctx){
    var data = ctx.instance ? ctx.instance : ctx.data;
    return data.concreteClass && data.concreteClass === ctx.Model.modelName;
  };

  var getWhereChild = function(data, model){
    return {where: {"parentClassId": data[model.getIdName()]}};
  };

  Model.defineProperty('concreteClass', {type: String, required: false});

  if(hasAbstractParent(Model)){
    console.log("DEFINING FUCKING PROP");
    Model.defineProperty('parentClassId', {type: String, required: true});
  }



  'use strict';
  Model.observe('before save', function event(ctx, next) { //Observe any insert/update event on Model
    //TODO Handle the update case
    var modelBase = ctx.Model.base;
    var incData = ctx.instance ? ctx.instance : ctx.data;

    if(hasAbstractParent(ctx.Model)){
      if(!isInternalCall(ctx)){
        //TODO should something be done about the parent when we update the child
        if("parentClassId" in incData){
          next();
        } else {
          var tmpAbstractObj = {};
          for(var key in modelBase.definition.properties){
            tmpAbstractObj[key] = incData[key];
          }
          if(ctx.currentInstance){
            modelBase.updateAll({id: ctx.currentInstance["parentClassId"]}, tmpAbstractObj, {"internalCall": true, "normalLoad": true}).then(function(){
              next();
            }).catch(function(err){
              next(err);
            });
          } else {
            modelBase.create(tmpAbstractObj, {"internalCall": true}, function(err, models){
              if(err){
                next(err);
              } else {
                incData["parentClassId"] = models[modelBase.getIdName()];
                next();
              }
            });
          }
        }
      } else {
        next();
      }
    } else {
      if(!isInternalCall(ctx)){
        // COPY incData to concreteInst for later insertion of child
        ctx.options.concreteInst = JSON.parse(JSON.stringify(incData));
      }
      //Deleting extra keys from child element
      Object.keys(incData)
        .filter(function(el){ return el[0] != "_";})
        .forEach(function(extraKey){
          if(ctx.instance){
            incData.unsetAttribute(extraKey);
          } else {
            if(! (extraKey in ctx.Model.definition.properties)){
              delete incData[extraKey];
            }
          }
        });
      ctx.options.normalLoad = true;
      ctx.options.isUpdate = true;

      if(ctx.currentInstance){
        var concreteClass = ctx.currentInstance.concreteClass;
        incData["concreteClass"] = ctx.currentInstance.concreteClass;
        if(concreteClass){
          concreteClass = app.models[concreteClass];
          concreteClass.updateAll(getWhereChild(ctx.currentInstance, ctx.Model).where, ctx.options.concreteInst, {"internalCall": true, "normalLoad": true}).then(function(){
              next();
          }).catch(function(err){
              next(err);
          });
        }
      } else {
        next();
      }

    }
  });

  Model.observe("after save", function(ctx, next){
    var incData = ctx.instance ? ctx.instance : ctx.data;

    if(!hasAbstractParent(ctx.Model) && !isConcreteModel(ctx) && !isInternalCall(ctx) && !(ctx.options.isUpdate)){
      //Child creation required
        var concreteModel = app.models[incData["concreteClass"]];
        ctx.options.concreteInst["parentClassId"] = incData[ctx.Model.getIdName()];
        concreteModel.create(ctx.options.concreteInst, {"internalCall": true}, function (err) {
          if (err) {
            if(ctx.isNewInstance){
              ctx.Model.deleteById(incData[ctx.Model.getIdName()], {"internalCall": true});
            }
            next(err);
          }
          next();
        });
    } else {
      next();
    }
  });

  //TODO FIXME loaded should only have effects on find operations?
  Model.observe('loaded', function(ctx, next){
    var data = ctx.instance ? ctx.instance : ctx.data;
    var concreteClass = data.concreteClass;
    if(!isConcreteModel(ctx) && !ctx.options.normalLoad){
      var concreteModel = app.models[concreteClass];
      var baseModel = ctx.Model;
      if(concreteModel){
        concreteModel.findOne(getWhereChild(data,baseModel), function(err, models){
          if(!err){
            if(models){
              for(var key in concreteModel.definition.properties){
                //Don't replace the parentId
                if(key === baseModel.getIdName() || key === "parentClassId"){
                  continue;
                }
                ctx.instance.setAttribute(key, models[key]);
              }
            }
            next();
          } else {
            next(err);
          }
        });
      } else {
        next();
      }

    } else {
      next();
    }
  });

  Model.observe('before delete', function(ctx, next){
    var data = ctx.instance ? ctx.instance : ctx.data;
    var where = ctx.where;
    var cbWhenDone = function(nb, cb){
      var nb = nb;
      var cb = cb;
      return {callMaybe: function(){
        nb--;
        if(nb == 0){
          cb();
        }
      }}
    };
    ctx.options.normalLoad = true;
    if(!isInternalCall(ctx)){
        var baseModel = ctx.Model.base;
        ctx.Model.find({where:where},{"normalLoad": true}).then(function(models){
          var callWhenDone = cbWhenDone(models.length, next);
          //TODO FIXME this might lead to parent model being deleted but not the child one
          // though to delete safely the child one it'd require to delete them one by one
          // which then defeats the original behaviour of the delete?
          // Also I guess an error should actually delete NO elements? Whereas here we might delete elements even though
          // they will not all be deleted cause of error later on?

            models.forEach(function (model) {
              if(hasAbstractParent(ctx.Model)) {
                baseModel.deleteById(model["parentClassId"], {"internalCall": true}).then(function () {
                  callWhenDone.callMaybe();
                }).catch(function (err) {
                  next(err);
                });
              } else {
                if (model.concreteClass) {
                  var concreteModel = app.models[model.concreteClass];
                  concreteModel.deleteAll(getWhereChild(model, ctx.Model).where, {"internalCall": true}).then(function () {
                    callWhenDone.callMaybe();
                  }).catch(function (err) {
                    next(err);
                  });
                } else {
                  next();
                }
              }
            });
        }).catch(function(err){
          next(err);
        });
      } else {
        next();
    }
  });
};
