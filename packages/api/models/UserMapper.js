'use strict';

class NotImplementedError extends Error {
  constructor() {
    super('Method not implemented');
    this.name = this.constructor.name;
  }
}

class RecordDoesNotExist extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

class UserRecordSet {
  constructor(userName) {
    this.userName = userName;
  }
}

class User {
  constructor(userName) {
    this._userName = userName;
  }

  get username() {
    return this._userName;
  }

  static fromUserRecordSet(userRecordSet) {
    const newUser = new User(userRecordSet.userName);

    newUser.expires = userRecordSet.expires;
    newUser.password = userRecordSet.password;
    newUser.refresh = userRecordSet.refresh;

    return newUser;
  }

  toUserRecordSet() {
    return new UserRecordSet({
      expires: this.expires,
      password: this.password,
      refresh: this.refresh,
      userName: this.userName
    });
  }
}

class UserDataMapper {
  constructor(userTableDataGateway) {
    this.userTableDataGateway = userTableDataGateway;
  }

  async findByUserName(userName) {
    const userRecordSet = await this.userTableDataGateway.findByUserName(userName);

    return User.fromUserRecordSet(userRecordSet);
  }

  async insert(user) {
    return this.userTableDataGateway.insert()
  }

  async delete(user) {
    return this.userTableDataGateway.delete(user.userName);
  }
}

/**
 * @interface
 */
class UserTableDataGateway {
  async findByUserName() {
    throw new NotImplementedError();
  }

  insert() {
    throw new NotImplementedError();
  }

  delete() {
    throw new NotImplementedError();
  }
}

class DynamoDbUserTableDataGateway extends UserTableDataGateway {
  constructor(dynamoDbClient, tableName) {
    super();
    this.dynamoDbClient = dynamoDbClient;
    this.tableName = tableName;
  }

  /**
   * @returns {UserRecordSet}
   */
  async findByUserName(userName) {
    const params = this.tableAndKeyParams(userName);
    const userItem = await this.getUserItem(params);

    return new UserRecordSet({
      userName: userItem.userName.S
    });
  }

  async delete(userName) {
    const params = this.tableAndKeyParams(userName);

    await this.dynamoDbClient.deleteItem(params).promise();

    return null;
  }

  /**
   * @private
   */
  tableAndKeyParams(userName) {
    return {
      TableName: this.tableName,
      Key: {
        userName: {
          S: userName
        }
      }
    };
  }

  /**
   * @private
   */
  async getUserItem(params) {
    const getItemResponse = await this.dynamoDbClient.getItem(params).promise();

    const userItem = getItemResponse.Item;

    if (!userItem) {
      throw new RecordDoesNotExist('User not found');
    }

    return userItem;
  }
}
