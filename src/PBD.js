// The MIT License (MIT)
// Copyright (c) 2020 NVIDIA
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// Position Based Dynamics Library
// Matthias Müller, NVIDIA

(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
	typeof define === 'function' && define.amd ? define(['exports'], factory) :
	(global = global || self, factory(global.PBD = {}));
}(this, (function (exports) { 'use strict';


var maxRotationPerSubstep = 0.5;
const AllCBodyPositions = [];
const AllCJointPositions = [];
// Pose  -----------------------------------------------------------

class Pose { //component in rigidbody class, aside from p and q; contains methods only
    constructor() {
        this.p = new THREE.Vector3(0.0, 0.0, 0.0);
        this.q = new THREE.Quaternion(0.0, 0.0, 0.0, 1.0);					
    }
    copy(pose) {//copies pose, ie. vector and quaternion
        this.p.copy(pose.p);
        this.q.copy(pose.q);
    }
    clone() { //creates new pose with same values
        var newPose = new Pose();
        newPose.p = this.p.clone();
        newPose.q = this.q.clone();
        return newPose;
    }   
    rotate(v) { //applies quaternion q on vector v (used to rotate)
        v.applyQuaternion(this.q);
    }
    invRotate(v) {//same as rotate, but inversed, is done by using quaternion.conjugate() and applying it on vector v
        let inv = this.q.clone();
        inv.conjugate();
        v.applyQuaternion(inv);
    }
    transform(v) { //transforms?? not sure about this but v seems to be a pose
        v.applyQuaternion(this.q);
        v.add(this.p);
    }
    invTransform(v) { //same as transform, but again, inversed. v is pose here as shown in line 304, 307
        v.sub(this.p);
        this.invRotate(v);
    }
    transformPose(pose) {//
        pose.q.multiplyQuaternions(this.q, pose.q);//sets value of pose.q to the composition of quaternions this.q and pose.q 
        this.rotate(pose.p); //apply quaternion this.q on pose.p
        pose.p.add(this.p); //add this.p to pose.p
    }   
}
//name suggests that function gets the axis(vector) from a quaterntion, probably some kind of formula
function getQuatAxis0(q) {
	let x2 = q.x * 2.0;//key difference on each function? Axis0 = x, Axis1 = y, Axis2 = z
    let w2 = q.w * 2.0;
    return new THREE.Vector3((q.w * w2) - 1.0 + q.x * x2, (q.z * w2) + q.y * x2, (-q.y * w2) + q.z * x2);
}
function getQuatAxis1(q) {
	let y2 = q.y * 2.0;
    let w2 = q.w * 2.0;
    return new THREE.Vector3((-q.z * w2) + q.x * y2, (q.w * w2) - 1.0 + q.y * y2, (q.x * w2) + q.z * y2);
}
function getQuatAxis2(q) {
	let z2 = q.z * 2.0;
	let w2 = q.w * 2.0;
	return new THREE.Vector3((q.y * w2) + q.x * z2, (-q.x * w2) + q.y * z2, (q.w * w2) - 1.0 + q.z * z2);
} 

// Rigid body class  -----------------------------------------------------------

class Body {
    constructor(pose, mesh) 
    { 
        this.pose = pose.clone();
        this.prevPose = pose.clone();
        this.origPose = pose.clone();
        this.vel = new THREE.Vector3(0.0, 0.0, 0.0);
        this.omega = new THREE.Vector3(0.0, 0.0, 0.0);
        
        this.invMass = 1.0;
        this.invInertia = new THREE.Vector3(1.0, 1.0, 1.0);
        this.mesh = mesh; //the literal box shown in the simulation it seems like, obvsly mesh
        this.mesh.position.copy(this.pose.p);// set correct position
        this.mesh.quaternion.copy(this.pose.q);//set correct orientation/rotation
        mesh.userData.physicsBody = this;// no idea, built-in method? override?
    }

    setBox(size, density = 1.0) { //density is default 1, size is vector?
        let mass = size.x * size.y * size.z * density; // m  = V*density ?
        this.invMass = 1.0 / mass; //inverse mass, duh
        mass /= 12.0; //why are we dividing by 12?
        this.invInertia.set( //inertia tensor used for calculating forces and stuff
            1.0 / (size.y * size.y + size.z * size.z) / mass,
            1.0 / (size.z * size.z + size.x * size.x) / mass,
            1.0 / (size.x * size.x + size.y * size.y) / mass);
    }

    applyRotation(rot, scale = 1.0) {

        // safety clamping. This happens very rarely if the solver
        // wants to turn the body by more than 30 degrees in the
        // orders of milliseconds

        //^but is it really working as intended? shit seems to spin a lot

        let maxPhi = 0.5;
        let phi = rot.length();
        if (phi * scale > maxRotationPerSubstep) 
            scale = maxRotationPerSubstep / phi;
            
        let dq = new THREE.Quaternion(rot.x * scale, rot.y * scale, rot.z * scale, 0.0);					
        dq.multiply(this.pose.q);
        this.pose.q.set(this.pose.q.x + 0.5 * dq.x, this.pose.q.y + 0.5 * dq.y, 
                this.pose.q.z + 0.5 * dq.z, this.pose.q.w + 0.5 * dq.w);
        this.pose.q.normalize();
    }
    //1st to be called in the simulate function, what it do?
    //this one calculates shit, other one sets pos accordingly
    integrate(dt, gravity) { //gravity = -10, dt = timeStep/numSubsteps (very small number)
        this.prevPose.copy(this.pose);//previous pose is now this pose
        this.vel.addScaledVector(gravity, dt);//update velocity by vel += (gravity * dt)
        this.pose.p.addScaledVector(this.vel, dt); //update position of current pose, same method but for position
        this.applyRotation(this.omega, dt);//safety clamping, see above
    }
    //3rd called in simulate function
    update(dt) { //im guessing this one actually updates all the bodies
        this.vel.subVectors(this.pose.p, this.prevPose.p); //velocity is current pose - previous pose
        this.vel.multiplyScalar(1.0 / dt); //multiply new velocity by 1/dt (dt is small number)
        let dq = new THREE.Quaternion();//multiplying quaternions performs one rotaion then the other
        dq.multiplyQuaternions(this.pose.q, this.prevPose.q.conjugate()); //why the conjugate?
        this.omega.set(dq.x * 2.0 / dt, dq.y * 2.0 / dt, dq.z * 2.0 / dt); //what and why?
        if (dq.w < 0.0) //what is omega even?
            this.omega.set(-this.omega.x, -this.omega.y, -this.omega.z); //inverse omega if dq.w is negative

        // this.omega.multiplyScalar(1.0 - 1.0 * dt);
        // this.vel.multiplyScalar(1.0 - 1.0 * dt);

        this.mesh.position.copy(this.pose.p);
        this.mesh.quaternion.copy(this.pose.q);
    }

    getVelocityAt(pos) {//gets velocity at position pos
        let vel = new THREE.Vector3(0.0, 0.0, 0.0);
        vel.subVectors(pos, this.pose.p);//new vel is current position and next position? or current and old position?
        vel.cross(this.omega);//cross-product with omega
        vel.subVectors(this.vel, vel);
        return vel;
    }

    getInverseMass(normal, pos = null) {//guess what this descriptive function does
        let n = new THREE.Vector3();
        if (pos === null) 
            n.copy(normal);
        else {
            n.subVectors(pos, this.pose.p);
            n.cross(normal);
        }
        this.pose.invRotate(n);
        let w = 
            n.x * n.x * this.invInertia.x +
            n.y * n.y * this.invInertia.y +
            n.z * n.z * this.invInertia.z;
        if (pos !== null)
            w += this.invMass;
        return w;
    }
    //check when this is called for more info i guess
    applyCorrection(corr, pos = null, velocityLevel = false) { //corr / corr is defo a vector3, seems to be taken from getQuataxis function
        let dq = new THREE.Vector3();
        if (pos === null) 
            dq.copy(corr);
        else {
            if (velocityLevel)
                this.vel.addScaledVector(corr, this.invMass);
            else
                this.pose.p.addScaledVector(corr, this.invMass);
            dq.subVectors(pos, this.pose.p);
            dq.cross(corr);
        }
        this.pose.invRotate(dq);
        dq.set(this.invInertia.x * dq.x, 
            this.invInertia.y * dq.y, this.invInertia.z * dq.z);
        this.pose.rotate(dq);
        if (velocityLevel)
            this.omega.add(dq);
        else 
            this.applyRotation(dq);
    }
}

// ------------------------------------------------------------------------------------

function applyBodyPairCorrection(body0, body1, corr, compliance, dt, pos0 = null, pos1 = null, 
    velocityLevel = false) 
{
    let C = corr.length();
    if ( C == 0.0)
        return;

    let normal = corr.clone();
    normal.normalize();

    let w0 = body0 ? body0.getInverseMass(normal, pos0) : 0.0;
    let w1 = body1 ? body1.getInverseMass(normal, pos1) : 0.0;

    let w = w0 + w1;
    if (w == 0.0)
        return;

    let lambda = -C / (w + compliance / dt / dt);
    normal.multiplyScalar(-lambda);
    if (body0)
        body0.applyCorrection(normal, pos0, velocityLevel);
    if (body1) {
        normal.multiplyScalar(-1.0);
        body1.applyCorrection(normal, pos1, velocityLevel);
    }
}

// ------------------------------------------------------------------------------------------------

function limitAngle(body0, body1, n, a, b, minAngle, maxAngle, compliance, dt, maxCorr = Math.PI)
{
    // the key function to handle all angular joint limits
    let c = new THREE.Vector3();
    c.crossVectors(a, b);

    let phi = Math.asin(c.dot(n));
    if (a.dot(b) < 0.0)
        phi = Math.PI - phi;

    if (phi > Math.PI)
        phi -= 2.0 * Math.PI;
    if (phi < -Math.PI)
        phi += 2.0 * Math.PI;

    if (phi < minAngle || phi > maxAngle) {
        phi = Math.min(Math.max(minAngle, phi), maxAngle);

        let q = new THREE.Quaternion();
        q.setFromAxisAngle(n, phi);

        let omega = a.clone();
        omega.applyQuaternion(q);
        omega.cross(b);

        phi = omega.length();
        if (phi > maxCorr) 
            omega.multiplyScalar(maxCorr / phi);

        applyBodyPairCorrection(body0, body1, omega, compliance, dt);
    }
}	

// Joint class  -----------------------------------------------------------

const JointType = {
    SPHERICAL: "spherical",
    HINGE: "hinge",
    FIXED: "fixed"
}

class Joint {
    constructor(type, body0, body1, localPose0, localPose1) 
    { 
        this.body0 = body0; //used from previous class (rigid body class)
        this.body1 = body1;
        this.localPose0 = localPose0.clone(); //method (clone) found in rigidbody class
        this.localPose1 = localPose1.clone(); // just makes a new copy of whatever, 
        this.globalPose0 = localPose0.clone();//in this case, a new copy of localPose, set to this.someshit
        this.globalPose1 = localPose1.clone();

        this.type = type; //what
        this.compliance = 0.0;
        this.rotDamping = 0.0; //rotational damping?brb wiki. uses friction do dampen energy/speed(?) (damping torqe?)
        this.posDamping = 0.0;//damping has the effect of reducing or preventing oscillation (in an oscillatory system like this)
        //important variables? does tweaking this make any significant difference? prob not
        this.hasSwingLimits = false;
        this.minSwingAngle = -2.0 * Math.PI;
        this.maxSwingAngle = 2.0 * Math.PI;
        this.swingLimitsCompliance = 0.0;
        this.hasTwistLimits = false;
        this.minTwistAngle = -2.0 * Math.PI;
        this.maxTwistAngle = 2.0 * Math.PI;
        this.twistLimitCompliance = 0.0;
    }

    updateGlobalPoses() {
        this.globalPose0.copy(this.localPose0);
        if (this.body0) //if body0 is defined/has value
            this.body0.pose.transformPose(this.globalPose0); //update the pose.p and quaternion pose.q
        this.globalPose1.copy(this.localPose1); //copy localPose1
        if (this.body1)//if body1 is defined/has value
            this.body1.pose.transformPose(this.globalPose1);//update the pose.p and quaternion pose.q
    }

    solvePos(dt) { //called in simulate function, for all joints
        //one of the important functions, duh, learn it

        this.updateGlobalPoses();//see above

        // orientation

        if (this.type == JointType.FIXED) { //this.type is set in index.html, in this case SPHERICAL
            let q = globalPose0.q;
            q.conjugate();
            q.multiplyQuaternions(globalPose1.q, q);
            let omega = new THREE.Vector3();
            omega.set(2.0 * q.x, 2.0 * q.y, 2.0 * q.z);
            if (omega.w < 0.0)
                omega.multiplyScalar(-1.0);
            applyBodyPairCorrection(body0, body1, omega, this.compliance, dt);						
        }

        if (this.type == JointType.HINGE) {

            // align axes
            let a0 = getQuatAxis0(this.globalPose0.q);
            let b0 = getQuatAxis1(this.globalPose0.q);
            let c0 = getQuatAxis2(this.globalPose0.q);
            let a1 = getQuatAxis0(this.globalPose1.q);
            a0.cross(a1);
            applyBodyPairCorrection(this.body0, this.body1, a0, 0.0, dt);

            // limits
            if (this.hasSwingLimits) {
                this.updateGlobalPoses();
                let n = getQuatAxis0(this.globalPose0.q);
                let b0 = getQuatAxis1(this.globalPose0.q);
                let b1 = getQuatAxis1(this.globalPose1.q);
                limitAngle(this.body0, this.body1, n, b0, b1, 
                    this.minSwingAngle, this.maxSwingAngle, this.swingLimitsCompliance, dt);
            }
        }

        if (this.type == JointType.SPHERICAL) {

            // swing limits
            if (this.hasSwingLimits) {
                this.updateGlobalPoses();
                let a0 = getQuatAxis0(this.globalPose0.q);
                let a1 = getQuatAxis0(this.globalPose1.q);
                let n = new THREE.Vector3();
                n.crossVectors(a0, a1);
                n.normalize();
                limitAngle(this.body0, this.body1, n, a0, a1, 
                    this.minSwingAngle, this.maxSwingAngle, this.swingLimitsCompliance, dt);
            }
            // twist limits
            if (this.hasTwistLimits) {
                this.updateGlobalPoses();
                let n0 = getQuatAxis0(this.globalPose0.q);
                let n1 = getQuatAxis0(this.globalPose1.q);
                let n = new THREE.Vector3();
                n.addVectors(n0, n1)
                n.normalize();
                let a0 = getQuatAxis1(this.globalPose0.q);
                a0.addScaledVector(n, -n.dot(a0));
                a0.normalize();
                let a1 = getQuatAxis1(this.globalPose1.q);
                a1.addScaledVector(n, -n.dot(a1));
                a1.normalize();

                // handling gimbal lock problem
                let maxCorr = n0.dot(n1) > -0.5 ? 2.0 * Math.Pi : 1.0 * dt;		
               
                limitAngle(this.body0, this.body1, n, a0, a1, 
                    this.minTwistAngle, this.maxTwistAngle, this.twistLimitCompliance, dt, maxCorr);
            }
        }

        // position
        
        // simple attachment

        this.updateGlobalPoses();
        let corr = new THREE.Vector3();
        corr.subVectors(this.globalPose1.p, this.globalPose0.p);
        applyBodyPairCorrection(this.body0, this.body1, corr, this.compliance, dt,
            this.globalPose0.p, this.globalPose1.p);	
    }

    solveVel(dt) { 

        // Gauss-Seidel lets us make damping unconditionally stable in a 
        // very simple way. We clamp the correction for each constraint
        // to the magnitude of the currect velocity making sure that
        // we never subtract more than there actually is.

        if (this.rotDamping > 0.0) {
            let omega = new THREE.Vector3(0.0, 0.0, 0.0);
            if (this.body0)
                omega.sub(this.body0.omega);
            if (this.body1)
                omega.add(this.body1.omega); 
            omega.multiplyScalar(Math.min(1.00, this.rotDamping * dt));
            applyBodyPairCorrection(this.body0, this.body1, omega, 0.0, dt, 
                    null, null, true);
        }
        if (this.posDamping > 0.0) {
            this.updateGlobalPoses();
            let vel = new THREE.Vector3(0.0, 0.0, 0.0);
            if (this.body0)
                vel.sub(this.body0.getVelocityAt(this.globalPose0.p));
            if (this.body1)
                vel.add(this.body1.getVelocityAt(this.globalPose1.p));
            vel.multiplyScalar(Math.min(1.0, this.posDamping * dt));
            applyBodyPairCorrection(this.body0, this.body1, vel, 0.0, dt, 
                    this.globalPose0.p, this.globalPose1.p, true);
        }
    }	
}
/* function simulate1(bodies, joints, timeStep, numSubsteps, gravity) {
    let dt = timeStep / numSubsteps;

    for (let i = 0; i < numSubsteps; i++) {
        for (let j = 0; j < bodies.length; j++) 
            bodies[j].integrate(dt, gravity);

        for (let j = 0; j < joints.length; j++)
            joints[j].solvePos(dt);

        for (let j = 0; j < bodies.length; j++) 
            bodies[j].update(dt);

        for (let j = 0; j < joints.length; j++)
            joints[j].solveVel(dt);
    }
} */
// Simulate -----------------------------------------------------------
//i think the key is to change shit here
//function simulate(bodies, joints, timeStep, numSubsteps, gravity) {
function simulate(calcBodies, caclJoints, timeStep, numSubsteps, gravity, bodies, joints) {
    let dt = timeStep / numSubsteps;
//inject code here maybe
//fewer bodies to run through as well as joints
    /*for (let i = 0; i < numSubsteps; i++) {
        
        for (let j = 0; j < bodies.length; j++) 
            bodies[j].integrate(dt, gravity);

        for (let j = 0; j < joints.length; j++)
            joints[j].solvePos(dt);

        for (let j = 0; j < bodies.length; j++) 
            bodies[j].update(dt);

        for (let j = 0; j < joints.length; j++)
            joints[j].solveVel(dt);
    }*/
    
    
    for (let i = 0; i < numSubsteps; i++) {
        
        for (let j = 0; j < calcBodies.length; j++) 
        calcBodies[j].integrate(dt, gravity);

        for (let j = 0; j < caclJoints.length; j++)
        caclJoints[j].solvePos(dt);

        for (let j = 0; j < calcBodies.length; j++) 
        calcBodies[j].update(dt);

        for (let j = 0; j < caclJoints.length; j++)
        caclJoints[j].solveVel(dt);
    }
    // let counter = 0;
    if(AllCBodyPositions.length == 0){
        for (let i = 0; i < calcBodies.length; i++){
            AllCBodyPositions.push([]);
            AllCJointPositions.push([]);
            }
    }
    for (let i = 0; i < calcBodies.length; i++){
        AllCBodyPositions[i].push(calcBodies[i]);
        AllCJointPositions[i].push(caclJoints[i]);
    }
    
    //console.log(calcBodies);

    // for (let i = 0; i < bodies.length-1; i+=2){
        
    //     bodies[i].mesh.position.copy(calcBodies[counter].pose.p);
    //     bodies[i].mesh.quaternion.copy(calcBodies[counter].pose.q);
    //     //console.log(i+" första");
        
    //     let tempV = new THREE.Vector3(0.0, 0.05, 0.0);
    //     tempV.addVectors(calcBodies[counter].pose.p, tempV);
    //     bodies[i+1].mesh.position.copy(tempV);
    //     bodies[i+1].mesh.quaternion.copy(calcBodies[counter].pose.q);
    //     //console.log(i+1 +"  andra");

    //     /*tempV = new THREE.Vector3(0.0, 0.1, 0.0);
    //     tempV.addVectors(calcBodies[counter].pose.p, tempV);
    //     bodies[i+2].mesh.position.copy(tempV);
    //     bodies[i+2].mesh.quaternion.copy(calcBodies[counter].pose.q);
    //     //console.log(i+2 +" tredje");

    //     tempV = new THREE.Vector3(0.0, 0.15, 0.0);
    //     tempV.addVectors(calcBodies[counter].pose.p, tempV);
    //     bodies[i+3].mesh.position.copy(tempV);
    //     bodies[i+3].mesh.quaternion.copy(calcBodies[counter].pose.q);
        
    //     tempV = new THREE.Vector3(0.0, 0.2, 0.0);
    //     tempV.addVectors(calcBodies[counter].pose.p, tempV);
    //     bodies[i+4].mesh.position.copy(tempV);
    //     bodies[i+4].mesh.quaternion.copy(calcBodies[counter].pose.q);*/
    //     counter += 1;
    //     //console.log(counter);
    // }
    
    // //console.log(counter);
    // //let tempV = new THREE.Vector3(-0.05, 0.08, -0.02);
    // //let tempV = new THREE.Vector3(-0.05, 0.085, -0.02);
    // //let tempV = new THREE.Vector3(-0.00, 0.085, 0);
    
    // let tempV = new THREE.Vector3(-0.00, 0.05, 0.045);
    
    // //tempV.addVectors(calcBodies[counter].pose.p, tempV);
    // tempV.addVectors(calcBodies[counter].pose.p, tempV);
    // bodies[bodies.length-1].mesh.position.copy(tempV);
    // //bodies[bodies.length-1].mesh.position.copy(calcBodies[counter].pose.p);
    // bodies[bodies.length-1].mesh.quaternion.copy(calcBodies[counter].pose.q);
    // //this.mesh.position.copy(this.pose.p);
    // //this.mesh.quaternion.copy(this.pose.q);


}
function AssignPos(calcBodies, bodies, timeStep , numSubsteps, gravity, someJoints){
    console.log(AllCBodyPositions);
    console.log(bodies);
    let dt = timeStep / numSubsteps;

    let counter = 0;
    
    for (let i = 0; i < calcBodies.length-1; i++){
        //console.log(calcBodies[i].mesh.position);
        calcBodies[i].mesh.position.copy(AllCBodyPositions[i][0].pose.p);
        calcBodies[i].mesh.quaternion.copy(AllCBodyPositions[i][0].pose.q);
        /* bodies[i].mesh.position.copy(AllCBodyPositions[counter][0].pose.p);
        bodies[i].mesh.quaternion.copy(AllCBodyPositions[counter][0].pose.q);
        let tempV = new THREE.Vector3(0.0, 0.05, 0.0);
        tempV.addVectors(AllCBodyPositions[counter][0].pose.p, tempV);
        bodies[i+1].mesh.position.copy(tempV);
        bodies[i+1].mesh.quaternion.copy(calcBodies[counter].pose.q); */
        counter++;
        
    } 
    let tempV = new THREE.Vector3(-0.00, 0.05, 0.045);
    
    //tempV.addVectors(calcBodies[counter].pose.p, tempV);
    //tempV.addVectors(AllPositions[counter][0].pose.p, tempV);
    tempV.addVectors(AllCBodyPositions[counter][0].mesh.position, tempV);
    calcBodies[calcBodies.length-1].pose.p.copy(tempV);
    //bodies[bodies.length-1].mesh.position.copy(calcBodies[counter].pose.p);
    calcBodies[calcBodies.length-1].pose.q.copy(AllCBodyPositions[counter][0].pose.q);
    //calcBodies[calcBodies.length-1].pose.q.copy(AllCBodyPositions[counter][0].mesh.quaternion);
    //this.mesh.position.copy(this.pose.p);
    //this.mesh.quaternion.copy(this.pose.q);
    for(let i=0; i< AllCBodyPositions.length;i++){
        AllCBodyPositions[i].shift();
        AllCJointPositions[i].shift();
    }
    /* for (let j = 0; j < AllCBodyPositions.length; j++) {
        calcBodies[j].integrate(dt, gravity);
    }
    for (let j = 0; j < someJoints.length; j++){
        someJoints[j].solvePos(dt);
    }
    for (let j = 0; j < AllCBodyPositions.length; j++) {
        calcBodies[j].update(dt);
    }
    for (let j = 0; j < someJoints.length; j++){
        someJoints[j].solveVel(dt);
    } */
    
    

    
 
}

exports.Pose = Pose;
exports.Body = Body;
exports.JointType = JointType;
exports.Joint = Joint;

exports.simulate = simulate;
//exports.simulate1 = simulate1;
exports.AssignPos = AssignPos;
Object.defineProperty(exports, '__esModule', { value: true });

})));